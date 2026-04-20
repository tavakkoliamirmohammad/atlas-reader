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
CREATE INDEX IF NOT EXISTS idx_glossary_arxiv ON glossary(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_papers_published ON papers(published);
CREATE INDEX IF NOT EXISTS idx_conv_arxiv      ON conversations(arxiv_id);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
    arxiv_id UNINDEXED,
    title,
    authors,
    abstract,
    categories,
    tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
    INSERT INTO papers_fts (arxiv_id, title, authors, abstract, categories)
    VALUES (new.arxiv_id, new.title, new.authors, new.abstract, new.categories);
END;

CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
    UPDATE papers_fts SET title=new.title, authors=new.authors,
           abstract=new.abstract, categories=new.categories
     WHERE arxiv_id=new.arxiv_id;
END;

CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
    DELETE FROM papers_fts WHERE arxiv_id=old.arxiv_id;
END;
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

        # Backfill papers_fts from existing rows when the FTS index is empty
        # but the papers table has data (older DBs created before FTS5 existed).
        cur = conn.execute("SELECT COUNT(*) FROM papers")
        paper_count = cur.fetchone()[0]
        cur = conn.execute("SELECT COUNT(*) FROM papers_fts")
        fts_count = cur.fetchone()[0]
        if paper_count > 0 and fts_count == 0:
            conn.execute(
                """INSERT INTO papers_fts (arxiv_id, title, authors, abstract, categories)
                   SELECT arxiv_id, title, authors, abstract, categories FROM papers"""
            )


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
