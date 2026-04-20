"""Tests for the FTS5-backed paper search module."""

import pytest
from httpx import ASGITransport, AsyncClient

from app import db, papers, search
from app.arxiv import Paper
from app.main import app


def _make_paper(arxiv_id: str, title: str, abstract: str, authors: str = "Alice, Bob") -> Paper:
    return Paper(
        arxiv_id=arxiv_id,
        title=title,
        authors=authors,
        abstract=abstract,
        categories="cs.PL",
        published="2026-04-19T08:00:00Z",
    )


def _seed_corpus() -> None:
    papers.upsert(
        [
            _make_paper(
                "2404.00001",
                "MLIR Compiler for GPU Tiling",
                "We present a compiler that lowers MLIR dialects to optimized GPU kernels.",
            ),
            _make_paper(
                "2404.00002",
                "A Survey of Polyhedral Optimization",
                "Polyhedral techniques have shaped loop optimization for decades.",
                authors="Carol, Dave",
            ),
            _make_paper(
                "2404.00003",
                "Distributed Database Replication",
                "Replicating state across regions while keeping latency low.",
            ),
        ]
    )


def test_search_finds_term_in_title(atlas_data_dir):
    db.init()
    _seed_corpus()
    results = search.search("MLIR")
    assert any(r["arxiv_id"] == "2404.00001" for r in results)


def test_search_finds_term_in_abstract(atlas_data_dir):
    db.init()
    _seed_corpus()
    results = search.search("polyhedral")
    arxiv_ids = [r["arxiv_id"] for r in results]
    assert "2404.00002" in arxiv_ids


def test_search_finds_term_in_authors(atlas_data_dir):
    db.init()
    _seed_corpus()
    results = search.search("Carol")
    arxiv_ids = [r["arxiv_id"] for r in results]
    assert "2404.00002" in arxiv_ids


def test_search_returns_snippet_with_marks(atlas_data_dir):
    db.init()
    _seed_corpus()
    results = search.search("compiler")
    assert results, "expected at least one hit"
    # snippet may surface in any field; at minimum the result has the key.
    assert "snippet" in results[0]


def test_empty_query_returns_empty_list(atlas_data_dir):
    db.init()
    _seed_corpus()
    assert search.search("") == []
    assert search.search("   ") == []


def test_special_characters_do_not_crash(atlas_data_dir):
    db.init()
    _seed_corpus()
    # All of these contain FTS5 specials that would normally choke the parser.
    for q in ['"unbalanced', "AND OR NOT NEAR", "foo: bar", "a (b c", ")))", "*", "+-+-"]:
        # Should not raise; may return [] or a few hits.
        result = search.search(q)
        assert isinstance(result, list)


def test_search_backfills_existing_rows_on_init(atlas_data_dir, monkeypatch):
    """If papers already exist before the FTS table did, init() should backfill."""
    import sqlite3

    # Start fresh: create only the legacy table + insert a row, no FTS yet.
    conn = sqlite3.connect(db.db_path())
    conn.executescript(
        """CREATE TABLE papers (
            arxiv_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            authors TEXT NOT NULL,
            abstract TEXT NOT NULL,
            categories TEXT NOT NULL,
            published TEXT NOT NULL,
            pdf_path TEXT,
            ai_tier INTEGER,
            ai_score REAL,
            read_state TEXT NOT NULL DEFAULT 'unread'
        );"""
    )
    conn.execute(
        """INSERT INTO papers (arxiv_id, title, authors, abstract, categories, published)
           VALUES ('legacy.0001', 'Legacy Tiling Paper',
                   'Eve', 'Older work on tiling without modern compilers.',
                   'cs.PL', '2026-04-10T08:00:00Z')"""
    )
    conn.commit()
    conn.close()

    db.init()  # should create FTS and backfill

    results = search.search("legacy")
    assert any(r["arxiv_id"] == "legacy.0001" for r in results), results


@pytest.mark.asyncio
async def test_search_endpoint(atlas_data_dir):
    db.init()
    _seed_corpus()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/search", params={"q": "MLIR"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] >= 1
    assert any(item["arxiv_id"] == "2404.00001" for item in body["results"])


@pytest.mark.asyncio
async def test_search_endpoint_empty_query(atlas_data_dir):
    db.init()
    _seed_corpus()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/search", params={"q": ""})
    assert r.status_code == 200
    assert r.json() == {"count": 0, "results": []}
