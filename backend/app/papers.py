"""Paper repository: the only module that reads/writes the papers table."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from typing import Iterable, Optional

from app import db
from app.arxiv import Paper


def upsert(items: Iterable[Paper]) -> int:
    """Insert or replace paper rows. Returns number of rows written."""
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
    with db.connect() as conn:
        cur = conn.execute("SELECT * FROM papers WHERE arxiv_id = ?", (arxiv_id,))
        return cur.fetchone()


def list_recent(days: int = 1) -> list[sqlite3.Row]:
    """Return papers published within the last `days` days, newest first."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT * FROM papers WHERE published >= ? ORDER BY published DESC",
            (cutoff,),
        )
        return list(cur.fetchall())


def set_pdf_path(arxiv_id: str, path: str) -> None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE papers SET pdf_path = ? WHERE arxiv_id = ?", (path, arxiv_id)
        )
