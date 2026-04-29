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

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    event       TEXT NOT NULL,
    arxiv_id    TEXT
);

CREATE TABLE IF NOT EXISTS highlights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    arxiv_id    TEXT NOT NULL REFERENCES papers(arxiv_id),
    quote       TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT 'yellow',
    page        INTEGER,
    note        TEXT,
    rects       TEXT,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_highlights_arxiv ON highlights(arxiv_id);

CREATE TABLE IF NOT EXISTS glossary (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    arxiv_id    TEXT NOT NULL REFERENCES papers(arxiv_id),
    term        TEXT NOT NULL,
    definition  TEXT,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(arxiv_id, term)
);
CREATE TABLE IF NOT EXISTS digest_cache (
    -- (sorted-categories | days) key — a 7d view of cs.PL,cs.AR is one row.
    key         TEXT PRIMARY KEY,
    fetched_at  REAL NOT NULL,           -- unix epoch seconds
    payload     TEXT NOT NULL            -- JSON-encoded list[Paper]
);

CREATE INDEX IF NOT EXISTS idx_glossary_arxiv ON glossary(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
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
    """Create the database file and all tables if they don't exist.

    Also runs lightweight in-place migrations for older databases that pre-date
    a column. This is safe because Atlas is local single-user data.
    """
    with sqlite3.connect(db_path()) as conn:
        conn.executescript(SCHEMA)

        # Migration: add `rects TEXT` to highlights if it's missing (DBs
        # created before 2026-04-20).
        cur = conn.execute("PRAGMA table_info(highlights)")
        cols = {row[1] for row in cur.fetchall()}
        if "rects" not in cols:
            conn.execute("ALTER TABLE highlights ADD COLUMN rects TEXT")

        # Migration: add `model TEXT` to conversations (which AI backend/model
        # wrote the answer). NULL for rows predating persistence.
        cur = conn.execute("PRAGMA table_info(conversations)")
        conv_cols = {row[1] for row in cur.fetchall()}
        if "model" not in conv_cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN model TEXT")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Yield a connection with row_factory set; auto-commits on exit."""
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
