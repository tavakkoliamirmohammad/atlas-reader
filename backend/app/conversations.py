"""Per-paper chat history repository.

The chat UI is ephemeral (lives only in the frontend's React state) per the
user's privacy preference, so this module no longer writes anything during
normal request flow. The `append`/`history` API is preserved as a thin no-op
wrapper around the conversations table for tests + any future opt-in
persistence — it is NOT called from the streaming `ask` path.
"""

from __future__ import annotations

import sqlite3
from typing import List, Literal

from app import db


Role = Literal["user", "assistant", "system"]


def append(arxiv_id: str, role: Role, content: str) -> None:
    """Append a message row to the conversations table."""
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO conversations (arxiv_id, role, content) VALUES (?, ?, ?)",
            (arxiv_id, role, content),
        )


def history(arxiv_id: str) -> List[sqlite3.Row]:
    """Return all messages for the given paper, oldest first."""
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, role, content, created_at "
            "FROM conversations WHERE arxiv_id = ? ORDER BY id ASC",
            (arxiv_id,),
        )
        return list(cur.fetchall())
