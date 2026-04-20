import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import patch

from app import db
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
