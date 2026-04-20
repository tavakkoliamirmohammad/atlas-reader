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


import pytest
from httpx import ASGITransport, AsyncClient

from app import highlights, papers
from app.arxiv import Paper
from app.main import app


SAMPLE_R = Paper("rp1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


def test_add_stores_rects_as_json_and_list_for_returns_list(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE_R])
    rects = [
        {"x": 0.10, "y": 0.20, "width": 0.30, "height": 0.02},
        {"x": 0.10, "y": 0.24, "width": 0.25, "height": 0.02},
    ]
    new_id = highlights.add("rp1", "q", page=7, rects=rects)

    rows = highlights.list_for("rp1")
    assert len(rows) == 1
    assert rows[0]["id"] == new_id
    # list_for returns a Python list already deserialized from JSON.
    assert rows[0]["rects"] == rects


def test_add_allows_none_rects_for_backward_compat(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE_R])
    new_id = highlights.add("rp1", "q", page=1, rects=None)
    rows = highlights.list_for("rp1")
    assert rows[0]["rects"] is None
    assert rows[0]["id"] == new_id


@pytest.mark.asyncio
async def test_post_highlight_accepts_rects_and_get_returns_them(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE_R])
    rects = [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.02}]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        cr = await c.post(
            "/api/highlights/rp1",
            json={"quote": "hello", "color": "coral", "page": 2, "rects": rects},
        )
        assert cr.status_code == 200

        lr = await c.get("/api/highlights/rp1")
    assert lr.status_code == 200
    rows = lr.json()["highlights"]
    assert len(rows) == 1
    assert rows[0]["page"] == 2
    assert rows[0]["rects"] == rects
