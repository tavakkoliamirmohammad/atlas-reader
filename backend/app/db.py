"""SQLite schema and connection helpers for Atlas."""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    arxiv_id    TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    authors     TEXT NOT NULL,
    abstract    TEXT NOT NULL,
    categories  TEXT NOT NULL,
    published   TEXT NOT NULL,
    pdf_path    TEXT,
    ai_tier     INTEGER,
    ai_score    REAL,
    read_state  TEXT NOT NULL DEFAULT 'unread'
);

CREATE TABLE IF NOT EXISTS builds (
    date         TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT,
    paper_count  INTEGER,
    log          TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    arxiv_id    TEXT NOT NULL REFERENCES papers(arxiv_id),
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prefs (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_published ON papers(published);
CREATE INDEX IF NOT EXISTS idx_conv_arxiv      ON conversations(arxiv_id);
"""


def data_dir() -> Path:
    """Return the active data directory, honoring ATLAS_DATA_DIR."""
    p = Path(os.environ.get("ATLAS_DATA_DIR", str(Path.home() / ".atlas")))
    p.mkdir(parents=True, exist_ok=True)
    (p / "pdfs").mkdir(exist_ok=True)
    return p


def db_path() -> Path:
    return data_dir() / "atlas.db"


def init() -> None:
    """Create the database file and all tables if they don't exist."""
    with sqlite3.connect(db_path()) as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Yield a connection with row_factory set; auto-commits on exit."""
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
