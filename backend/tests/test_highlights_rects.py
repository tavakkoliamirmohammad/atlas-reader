"""Tests for the rects column on highlights (added 2026-04-20)."""

import sqlite3

from app import db


def test_init_adds_rects_column_if_missing(atlas_data_dir):
    # Create an old-shape highlights table without rects, like a pre-migration DB.
    with sqlite3.connect(db.db_path()) as conn:
        conn.execute(
            """CREATE TABLE highlights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                arxiv_id TEXT NOT NULL,
                quote TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT 'yellow',
                page INTEGER,
                note TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        conn.execute(
            "INSERT INTO highlights (arxiv_id, quote) VALUES (?, ?)",
            ("preexist", "old row"),
        )

    # Now run init — it should add the rects column without nuking the row.
    db.init()

    with sqlite3.connect(db.db_path()) as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(highlights)")}
        assert "rects" in cols

        cur = conn.execute("SELECT quote, rects FROM highlights WHERE arxiv_id='preexist'")
        row = cur.fetchone()
        assert row is not None
        assert row[0] == "old row"
        assert row[1] is None  # backfilled NULL on old rows


def test_init_is_idempotent_on_fresh_db(atlas_data_dir):
    db.init()
    db.init()  # second call must not raise "duplicate column name"
    with sqlite3.connect(db.db_path()) as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(highlights)")}
        assert "rects" in cols
