"""Paper repository: the only module that reads/writes the papers table."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

import httpx

from app import arxiv as _arxiv
from app import db
from app.arxiv import Paper


class ArxivUnavailable(Exception):
    """arXiv returned a retryable error (throttling, timeout) we couldn't overcome."""


async def ensure_imported(arxiv_id: str) -> bool:
    """Make sure ``arxiv_id`` has a row in the DB; fetch from arXiv on demand.

    Custom uploads (``custom-`` prefix) are never re-fetched — we only
    confirm the row already exists. Raises ``ArxivUnavailable`` on
    throttle/timeout so the route layer can render a clean 503.
    """
    # Deferred import: ``imports`` imports ``papers``, so a top-level reference
    # would create a cycle. The lookup is cached after the first call.
    from app import imports

    if get(arxiv_id) is not None:
        return True
    if imports.is_custom_id(arxiv_id):
        return False
    try:
        paper = await _arxiv.fetch_by_id(arxiv_id)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (429, 503):
            raise ArxivUnavailable(
                "arXiv is throttling this IP; try again in a few minutes"
            ) from exc
        raise
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise ArxivUnavailable(f"arXiv unreachable ({type(exc).__name__})") from exc
    if paper is None:
        return False
    upsert([paper])
    return True


def upsert(items: Iterable[Paper]) -> int:
    """Insert or replace paper rows. Returns the number of items processed.

    Abstracts are intentionally NOT stored (the column is kept as empty
    string for schema stability); Atlas persists only the titles/authors/
    categories needed to list and link to arXiv.
    """
    rows = [
        (p.arxiv_id, p.title, p.authors, "", p.categories, p.published)
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


def list_recent(days: int | None = 1) -> list[sqlite3.Row]:
    """Return papers published within the last `days` days, newest first.

    When `days` is None, return ALL papers ordered by published desc.
    """
    with db.connect() as conn:
        if days is None:
            cur = conn.execute(
                "SELECT * FROM papers ORDER BY published DESC",
            )
            return list(cur.fetchall())
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
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
