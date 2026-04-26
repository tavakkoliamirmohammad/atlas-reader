"""Read the codex CLI's local model cache (`~/.codex/models_cache.json`).

The codex CLI maintains this file itself, refreshing it whenever the user
launches the CLI. Atlas reads it directly so the picker stays current with
whatever codex itself can reach — no allowlist to keep in sync.

Only "list"-visibility models are returned, sorted by `priority` ascending
(ties broken alphabetically by slug) so the picker shows codex's own
preferred order.

Public surface:
- `CACHE_PATH()` — resolved path to the cache file (resolves Path.home()
  at call time so tests can monkeypatch).
- `cache_exists()` — quick `is_file` check, used by the /health gate.
- `load()` — read + parse + filter + sort. Raises `FileNotFoundError`
  (cache absent) or `ValueError` (cache unreadable) so callers can pick the
  appropriate HTTP status.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict


class CodexModel(TypedDict):
    slug: str
    label: str
    description: str


def CACHE_PATH() -> Path:
    return Path.home() / ".codex" / "models_cache.json"


def cache_exists() -> bool:
    """True iff the cache file exists AND parses to a usable model list.

    Used by `/health` to decide whether to advertise codex as available. We
    require *loadable* (not just present) because a corrupted/empty cache
    leaves the picker with nothing to render — better to mark unavailable
    than to show a broken dropdown.
    """
    try:
        return len(load()) > 0
    except (FileNotFoundError, ValueError):
        return False


def load() -> list[CodexModel]:
    """Return the filtered, sorted model list. Raises on missing/malformed cache."""
    path = CACHE_PATH()
    if not path.is_file():
        raise FileNotFoundError(str(path))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise ValueError(f"codex models cache unreadable: {exc}") from exc

    raw_models = data.get("models", []) if isinstance(data, dict) else []
    if not isinstance(raw_models, list):
        raise ValueError("codex models cache: 'models' field is not a list")

    visible = [m for m in raw_models if isinstance(m, dict) and m.get("visibility") == "list"]
    visible.sort(key=lambda m: (m.get("priority", 0), m.get("slug", "")))

    return [
        CodexModel(
            slug=str(m.get("slug", "")),
            label=str(m.get("display_name") or m.get("slug", "")),
            description=str(m.get("description", "")),
        )
        for m in visible
        if m.get("slug")
    ]
