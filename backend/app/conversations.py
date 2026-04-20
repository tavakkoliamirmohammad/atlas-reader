"""Per-paper chat history repository (conversations + threads tables)."""

from __future__ import annotations

import sqlite3
from typing import List, Literal

from app import db


Role = Literal["user", "assistant", "system"]

# Default thread used when callers don't specify one. All historical rows
# (created before multi-thread support landed) get thread_id=1 via the
# schema default and the on-disk migration in db.init().
DEFAULT_THREAD_ID = 1


def append(arxiv_id: str, role: Role, content: str, thread_id: int = DEFAULT_THREAD_ID) -> None:
    """Append a message row to the conversations table for a specific thread."""
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO conversations (arxiv_id, role, content, thread_id) "
            "VALUES (?, ?, ?, ?)",
            (arxiv_id, role, content, thread_id),
        )


def history(arxiv_id: str, thread_id: int = DEFAULT_THREAD_ID) -> List[sqlite3.Row]:
    """Return all messages for the given paper + thread, oldest first."""
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, role, content, thread_id, created_at "
            "FROM conversations WHERE arxiv_id = ? AND thread_id = ? ORDER BY id ASC",
            (arxiv_id, thread_id),
        )
        return list(cur.fetchall())


def list_threads(arxiv_id: str) -> List[sqlite3.Row]:
    """Return threads for a paper, oldest first.

    Always includes a synthetic default thread (id=1) so the UI has at least
    one tab even before the user explicitly creates a new thread.
    """
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, title, created_at "
            "FROM threads WHERE arxiv_id = ? ORDER BY id ASC",
            (arxiv_id,),
        )
        rows = list(cur.fetchall())

    if any(r["id"] == DEFAULT_THREAD_ID for r in rows):
        return rows

    # Synthesize the default thread row at the front of the list.
    default_row = {
        "id": DEFAULT_THREAD_ID,
        "arxiv_id": arxiv_id,
        "title": "Conversation",
        "created_at": None,
    }
    return [default_row, *rows]


def create_thread(arxiv_id: str, title: str = "Conversation") -> int:
    """Create a new thread for a paper and return its id.

    The id 1 is reserved for the synthetic default thread so that
    pre-existing conversation rows (which all carry thread_id=1) line up
    with a real tab. We therefore guarantee that real thread rows always
    have id >= 2 by seeding sqlite_sequence on first insert.
    """
    with db.connect() as conn:
        # Ensure AUTOINCREMENT skips id=1 (reserved for the default thread).
        # sqlite_sequence rows only exist after the first insert; seed it now.
        conn.execute(
            "INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES ('threads', 1)"
        )
        conn.execute(
            "UPDATE sqlite_sequence SET seq = MAX(seq, 1) WHERE name = 'threads'"
        )
        cur = conn.execute(
            "INSERT INTO threads (arxiv_id, title) VALUES (?, ?)",
            (arxiv_id, title),
        )
        return int(cur.lastrowid)
