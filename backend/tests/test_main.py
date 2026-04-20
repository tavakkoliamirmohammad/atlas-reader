import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app import db
from app.arxiv import Paper
from app.main import app


@pytest.mark.asyncio
async def test_health_endpoint_returns_ai_status(atlas_data_dir):
    db.init()
    with patch("app.main.health.claude_available", return_value=True):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ai"] is True
    assert "papers_today" in body


@pytest.mark.asyncio
async def test_health_endpoint_when_claude_missing(atlas_data_dir):
    db.init()
    with patch("app.main.health.claude_available", return_value=False):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.json()["ai"] is False


@pytest.mark.asyncio
async def test_digest_endpoint_triggers_build_and_returns_papers(atlas_data_dir):
    db.init()
    sample = [Paper("1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")]
    fake_build = AsyncMock(return_value=[])
    with patch("app.main.digest.build_today", fake_build):
        with patch("app.main.papers.list_recent", return_value=sample):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                r = await c.get("/api/digest?build=true")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["papers"][0]["arxiv_id"] == "1"
    fake_build.assert_awaited_once()


@pytest.mark.asyncio
async def test_digest_without_build_does_not_call_builder(atlas_data_dir):
    db.init()
    fake_build = AsyncMock()
    with patch("app.main.digest.build_today", fake_build):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest")
    fake_build.assert_not_called()
    assert r.status_code == 200
