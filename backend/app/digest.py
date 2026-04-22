"""Build today's digest: fetch arXiv category feeds independently and persist.

Design principles
-----------------
* **One simple `cat:X` query per category.** arXiv's search server resolves
  these via a single index lookup; no complex `OR` chains that time out.
* **Independent fetches.** `asyncio.gather(..., return_exceptions=True)` means
  one flaky category never wipes out the whole build — partial success persists
  what it got and records which categories failed.
* **No server-side or client-side filtering.** We used to run a title-keyword
  regex over the feed, but it had word-boundary false negatives (e.g. "GPUs"
  plural). Since search is first-class, a full feed + FTS5 is both simpler
  and more trustworthy than a hand-rolled filter.
* **Upsert dedupes.** Re-running the same query is a no-op on the DB; no
  need for per-source "last seen" bookkeeping.
* **No ranking.** Atlas no longer scores papers with AI — the list is purely
  chronological.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import date, datetime, timezone

from app import arxiv, db, papers


log = logging.getLogger(__name__)


# Categories relevant to a compiler / MLIR / PL / performance researcher.
# All fetched unfiltered; the user can search to narrow. Order here defines
# fetch order, which only matters for conflict resolution (first wins).
CATEGORIES = ("cs.PL", "cs.AR", "cs.DC", "cs.PF", "cs.LG")

MAX_PER_CATEGORY = 100
FETCH_TIMEOUT = 30.0


def _today_iso() -> str:
    return date.today().isoformat()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _start_build() -> None:
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO builds (date, status, started_at, finished_at, paper_count, log)
               VALUES (?, 'building', ?, NULL, 0, '')
               ON CONFLICT(date) DO UPDATE SET
                 status='building',
                 started_at=excluded.started_at,
                 finished_at=NULL,
                 paper_count=0,
                 log=''""",
            (_today_iso(), _now_iso()),
        )


def _finish_build(status: str, paper_count: int, log_text: str) -> None:
    with db.connect() as conn:
        conn.execute(
            """UPDATE builds
                 SET status = ?, finished_at = ?, paper_count = ?, log = ?
               WHERE date = ?""",
            (status, _now_iso(), paper_count, log_text, _today_iso()),
        )


async def _fetch_category(cat: str) -> list[arxiv.Paper]:
    return await arxiv.fetch_recent(
        f"cat:{cat}", max_results=MAX_PER_CATEGORY, timeout=FETCH_TIMEOUT
    )


async def build_today(**_ignored) -> list[sqlite3.Row]:
    """Fetch every category in parallel, persist, return last 7 days.

    Extra kwargs are accepted and ignored for backwards compatibility with
    callers that still pass `backend=` or `rank=`.
    """
    _start_build()

    results = await asyncio.gather(
        *(_fetch_category(c) for c in CATEGORIES),
        return_exceptions=True,
    )

    seen: dict[str, arxiv.Paper] = {}
    failures: list[str] = []

    for cat, res in zip(CATEGORIES, results):
        if isinstance(res, Exception):
            log.warning("fetch failed cat:%s: %s: %s", cat, type(res).__name__, res)
            failures.append(f"{cat}:{type(res).__name__}")
            continue
        for p in res:
            seen.setdefault(p.arxiv_id, p)

    if seen:
        papers.upsert(seen.values())

    if not failures:
        status = "done"
    elif len(failures) == len(results):
        status = "failed"
    else:
        status = "partial"
    _finish_build(status=status, paper_count=len(seen), log_text="; ".join(failures))
    return papers.list_recent(days=7)
