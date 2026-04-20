import sqlite3

import pytest

from app import db


def test_init_creates_database_file(atlas_data_dir):
    db.init()
    assert (atlas_data_dir / "atlas.db").exists()


def test_init_is_idempotent(atlas_data_dir):
    db.init()
    db.init()  # should not raise
    assert (atlas_data_dir / "atlas.db").exists()


def test_connect_returns_working_connection(atlas_data_dir):
    db.init()
    with db.connect() as conn:
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row[0] for row in cursor}
    assert "papers" in tables
    assert "builds" in tables
    assert "conversations" in tables
    assert "prefs" in tables


def test_papers_schema_has_expected_columns(atlas_data_dir):
    db.init()
    with db.connect() as conn:
        cursor = conn.execute("PRAGMA table_info(papers)")
        columns = {row[1] for row in cursor}
    assert {"arxiv_id", "title", "authors", "abstract", "categories",
            "published", "pdf_path", "ai_tier", "ai_score", "read_state"} <= columns


def test_foreign_keys_enforced(atlas_data_dir):
    db.init()
    with pytest.raises(sqlite3.IntegrityError):
        with db.connect() as conn:
            conn.execute(
                "INSERT INTO conversations (arxiv_id, role, content) VALUES (?, ?, ?)",
                ("does-not-exist", "user", "hello"),
            )
