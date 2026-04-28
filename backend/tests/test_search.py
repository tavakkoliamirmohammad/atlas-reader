"""Tests for the live arXiv-backed search module."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app import search
from app.arxiv import Paper
from app.main import app


def _paper(arxiv_id: str, title: str, abstract: str = "") -> Paper:
    return Paper(
        arxiv_id=arxiv_id,
        title=title,
        authors="Alice, Bob",
        abstract=abstract,
        categories="cs.PL",
        published="2026-04-19T08:00:00Z",
    )


@pytest.mark.asyncio
async def test_empty_query_returns_empty_list():
    """Whitespace-only or empty queries short-circuit before hitting arXiv."""
    with patch("app.search.arxiv.fetch_recent", new=AsyncMock()) as fetch:
        assert await search.search("") == []
        assert await search.search("   ") == []
    fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_search_passes_quoted_AND_query_to_arxiv():
    """Multi-word queries become `all:"foo" AND all:"bar"` so arXiv keeps them together."""
    fake = AsyncMock(return_value=[])
    with patch("app.search.arxiv.fetch_recent", fake):
        await search.search("MLIR compiler")
    args, kwargs = fake.await_args
    assert args[0] == 'all:"MLIR" AND all:"compiler"'


@pytest.mark.asyncio
async def test_search_returns_results_in_arxiv_order():
    fake = AsyncMock(
        return_value=[
            _paper("2404.00001", "MLIR Compiler", abstract="A long abstract."),
            _paper("2404.00002", "Other"),
        ]
    )
    with patch("app.search.arxiv.fetch_recent", fake):
        out = await search.search("MLIR")
    assert [r["arxiv_id"] for r in out] == ["2404.00001", "2404.00002"]
    assert "snippet" in out[0]


@pytest.mark.asyncio
async def test_special_characters_are_stripped_not_thrown():
    """User input with stray quotes/parens/colons should never raise."""
    fake = AsyncMock(return_value=[])
    with patch("app.search.arxiv.fetch_recent", fake):
        for q in ['"unbalanced', "AND OR NOT NEAR", "foo: bar", "a (b c", ")))", "*", "+-+-"]:
            result = await search.search(q)
            assert isinstance(result, list)


@pytest.mark.asyncio
async def test_search_swallows_arxiv_failures():
    """Network/parse errors return [] rather than 500-ing callers."""
    boom = AsyncMock(side_effect=RuntimeError("arxiv down"))
    with patch("app.search.arxiv.fetch_recent", boom):
        assert await search.search("MLIR") == []


@pytest.mark.asyncio
async def test_search_endpoint(atlas_data_dir):
    fake = AsyncMock(
        return_value=[_paper("2404.00001", "MLIR Compiler for GPU Tiling")]
    )
    with patch("app.search.arxiv.fetch_recent", fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/search", params={"q": "MLIR"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["results"][0]["arxiv_id"] == "2404.00001"


@pytest.mark.asyncio
async def test_search_endpoint_empty_query(atlas_data_dir):
    """Empty queries return an empty result without round-tripping arXiv."""
    with patch("app.search.arxiv.fetch_recent", new=AsyncMock()) as fake:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/search", params={"q": ""})
    assert r.status_code == 200
    assert r.json() == {"count": 0, "results": []}
    fake.assert_not_awaited()
