"""Per-paper text highlights repository."""

from __future__ import annotations

import sqlite3
from typing import List, Optional

from app import db


def add(
    arxiv_id: str,
    quote: str,
    color: str = "yellow",
    page: Optional[int] = None,
    note: Optional[str] = None,
) -> int:
    """Insert a new highlight row and return its primary key."""
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO highlights (arxiv_id, quote, color, page, note) "
            "VALUES (?, ?, ?, ?, ?)",
            (arxiv_id, quote, color, page, note),
        )
        return int(cur.lastrowid)


def list_for(arxiv_id: str) -> List[sqlite3.Row]:
    """Return highlights for a paper, newest first."""
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, quote, color, page, note, created_at "
            "FROM highlights WHERE arxiv_id = ? ORDER BY created_at DESC, id DESC",
            (arxiv_id,),
        )
        return list(cur.fetchall())


def delete(highlight_id: int) -> bool:
    """Delete a highlight by id. Returns True if a row was removed."""
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
        return cur.rowcount > 0
