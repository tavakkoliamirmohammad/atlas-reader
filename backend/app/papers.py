"""Paper repository: the only module that reads/writes the papers table."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from app import db
from app.arxiv import Paper


def upsert(items: Iterable[Paper]) -> int:
    """Insert or replace paper rows. Returns the number of items processed
    (which may exceed the number of distinct rows if the input contains
    duplicate arxiv_ids)."""
    rows = [
        (p.arxiv_id, p.title, p.authors, p.abstract, p.categories, p.published)
        for p in items
    ]
    with db.connect() as conn:
        conn.executemany(
            """INSERT INTO papers
                 (arxiv_id, title, authors, abstract, categories, published)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(arxiv_id) DO UPDATE SET
                 title=excluded.title,
                 authors=excluded.authors,
                 abstract=excluded.abstract,
                 categories=excluded.categories,
                 published=excluded.published""",
            rows,
        )
    return len(rows)


def get(arxiv_id: str) -> Optional[sqlite3.Row]:
    """Return the paper row, or None if no row matches that arxiv_id."""
    with db.connect() as conn:
        cur = conn.execute("SELECT * FROM papers WHERE arxiv_id = ?", (arxiv_id,))
        return cur.fetchone()


def list_recent(days: int = 1) -> list[sqlite3.Row]:
    """Return papers published within the last `days` days, newest first."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT * FROM papers WHERE published >= ? ORDER BY published DESC",
            (cutoff,),
        )
        return list(cur.fetchall())


def set_pdf_path(arxiv_id: str, path: str) -> None:
    """Update pdf_path for a paper. Silently no-ops if the arxiv_id does not exist."""
    with db.connect() as conn:
        conn.execute(
            "UPDATE papers SET pdf_path = ? WHERE arxiv_id = ?", (path, arxiv_id)
        )
