"""Per-paper text highlights repository."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, List, Optional

from app import db


def _rects_to_json(rects: Optional[List[dict]]) -> Optional[str]:
    if rects is None:
        return None
    return json.dumps(rects, separators=(",", ":"))


def _rects_from_json(raw: Any) -> Optional[List[dict]]:
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, list) else None


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = {k: row[k] for k in row.keys()}
    d["rects"] = _rects_from_json(d.get("rects"))
    return d


def add(
    arxiv_id: str,
    quote: str,
    color: str = "yellow",
    page: Optional[int] = None,
    note: Optional[str] = None,
    rects: Optional[List[dict]] = None,
) -> int:
    """Insert a new highlight row and return its primary key."""
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO highlights (arxiv_id, quote, color, page, note, rects) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (arxiv_id, quote, color, page, note, _rects_to_json(rects)),
        )
        return int(cur.lastrowid)


def list_for(arxiv_id: str) -> List[dict]:
    """Return highlights for a paper as plain dicts, newest first. `rects` is
    decoded from JSON back to a Python list (or None)."""
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, quote, color, page, note, rects, created_at "
            "FROM highlights WHERE arxiv_id = ? ORDER BY created_at DESC, id DESC",
            (arxiv_id,),
        )
        return [_row_to_dict(r) for r in cur.fetchall()]


def delete(highlight_id: int) -> bool:
    """Delete a highlight by id. Returns True if a row was removed."""
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
        return cur.rowcount > 0
