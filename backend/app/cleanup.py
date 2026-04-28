"""Periodic on-disk cleanup: TTL prune for podcast audio.

Atlas no longer caches arXiv listings, so the only thing that grows on
disk over time is `~/.atlas/podcasts/<id>/<length>.{mp3,json}`. Each
generated podcast is regenerable on demand, so dropping old ones is
strictly a space-saver — nothing irreplaceable is lost.

Triggered from /api/digest (= once per page load) with an in-process
throttle so filter toggles or rapid refreshes don't repeat the work.

Tunables:
  ATLAS_PODCAST_RETENTION_DAYS  default 30   -- delete files older than N days
  ATLAS_CLEANUP_THROTTLE_S      default 300  -- skip if last sweep was within N s
"""

from __future__ import annotations

import logging
import os
import time as _time
from pathlib import Path

from app import db


log = logging.getLogger(__name__)

PODCAST_TTL_DAYS_DEFAULT = 30
THROTTLE_S_DEFAULT = 5 * 60

_last_run: float = 0.0


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        n = int(raw)
        return n if n > 0 else default
    except ValueError:
        return default


def _prune_podcasts(root: Path, ttl_days: int) -> int:
    """Delete podcast (mp3, json) pairs older than `ttl_days`.

    Keeps the cache atomicity invariant from podcast.py: the .mp3 and .json
    are deleted as a pair (or skipped together). Empty per-paper directories
    are also removed so `~/.atlas/podcasts/` doesn't accumulate stubs.

    Returns the number of files removed.
    """
    if not root.exists():
        return 0
    cutoff = _time.time() - ttl_days * 86400
    removed = 0
    for paper_dir in root.iterdir():
        if not paper_dir.is_dir():
            continue
        for length in ("short", "medium", "long"):
            mp3 = paper_dir / f"{length}.mp3"
            jsn = paper_dir / f"{length}.json"
            mtimes: list[float] = []
            for f in (mp3, jsn):
                try:
                    mtimes.append(f.stat().st_mtime)
                except FileNotFoundError:
                    continue
            if not mtimes or min(mtimes) >= cutoff:
                continue
            for f in (mp3, jsn):
                try:
                    f.unlink()
                    removed += 1
                except FileNotFoundError:
                    pass
                except OSError:
                    log.exception("cleanup: failed to remove %s", f)
        try:
            if not any(paper_dir.iterdir()):
                paper_dir.rmdir()
        except OSError:
            pass
    return removed


def sweep(*, force: bool = False) -> dict[str, int]:
    """Run all configured cleanup steps.

    Throttled to once per ATLAS_CLEANUP_THROTTLE_S unless `force=True`.
    Safe to call from request handlers: the work is small (a few stat()s
    and unlink()s) and runs synchronously, so failures surface as logs
    rather than tracebacks to the user.
    """
    global _last_run
    throttle_s = _env_int("ATLAS_CLEANUP_THROTTLE_S", THROTTLE_S_DEFAULT)
    now = _time.monotonic()
    if not force and (now - _last_run) < throttle_s:
        return {"skipped": 1}
    _last_run = now

    podcast_ttl = _env_int("ATLAS_PODCAST_RETENTION_DAYS", PODCAST_TTL_DAYS_DEFAULT)
    counts = {
        "podcast_files": _prune_podcasts(db.data_dir() / "podcasts", podcast_ttl),
    }
    if any(counts.values()):
        log.info("cleanup sweep: %s", counts)
    return counts
