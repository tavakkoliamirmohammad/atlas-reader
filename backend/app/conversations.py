"""Per-paper chat-history repository.

Conversations are now persisted (one thread per paper). Each `/api/ask` call
writes the user question + assistant answer after the stream completes, so
the user can close the tab and resume the thread later.

Context-budget management (sliding window) is the asker's concern, not
this module's — here we just store and fetch rows.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Literal, Optional

from app import db


log = logging.getLogger(__name__)


Role = Literal["user", "assistant", "system"]


def append(arxiv_id: str, role: Role, content: str, model: Optional[str] = None) -> None:
    """Append a message row to the conversations table."""
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO conversations (arxiv_id, role, content, model) "
            "VALUES (?, ?, ?, ?)",
            (arxiv_id, role, content, model),
        )


def history(arxiv_id: str) -> List[sqlite3.Row]:
    """Return all messages for the given paper, oldest first."""
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, role, content, model, created_at "
            "FROM conversations WHERE arxiv_id = ? ORDER BY id ASC",
            (arxiv_id,),
        )
        return list(cur.fetchall())


def clear(arxiv_id: str) -> int:
    """Delete every message for a paper. Returns the number of rows removed."""
    with db.connect() as conn:
        cur = conn.execute(
            "DELETE FROM conversations WHERE arxiv_id = ?",
            (arxiv_id,),
        )
        return cur.rowcount


def prune_older_than(days: int) -> int:
    """Delete messages older than `days` days. Returns rows deleted.

    Only called by the background scheduler when ATLAS_CHAT_RETENTION_DAYS
    is set. Off by default.
    """
    if days <= 0:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    with db.connect() as conn:
        cur = conn.execute(
            "DELETE FROM conversations WHERE created_at < ?",
            (cutoff,),
        )
        return cur.rowcount


def prune_orphan_pdfs() -> int:
    """Remove cached PDFs with no matching row in `papers`.

    Safe to run any time — we only delete files that no database row
    references. Always-on (vs retention sweeps which are opt-in) because
    the blast radius is zero: if a PDF is still referenced, we skip it.
    """
    pdfs_dir = db.data_dir() / "pdfs"
    if not pdfs_dir.exists():
        return 0
    with db.connect() as conn:
        known = {row[0] for row in conn.execute("SELECT arxiv_id FROM papers")}
    removed = 0
    for f in pdfs_dir.glob("*.pdf"):
        if f.stem not in known:
            try:
                f.unlink()
                removed += 1
            except OSError:
                log.exception("failed to remove orphan pdf %s", f)
    return removed
