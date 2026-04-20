from contextlib import asynccontextmanager

import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app import db
from app.arxiv import Paper
from app.main import app


@pytest.mark.asyncio
async def test_full_round_trip_health_digest_paper_pdf(atlas_data_dir, fixtures_dir):
    """Build today's digest, fetch the digest, fetch one paper, fetch its PDF."""
    db.init()
    pl = [Paper("99", "Title", "A", "An abstract", "cs.PL", "2026-04-19T08:00:00Z")]
    other: list[Paper] = []
    pdf_bytes = (fixtures_dir / "tiny.pdf").read_bytes()

    class _FakeResp:
        def raise_for_status(self):
            pass

        async def aiter_bytes(self, chunk_size=64 * 1024):
            yield pdf_bytes

    @asynccontextmanager
    async def _fake_stream(self, method, url):
        yield _FakeResp()

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        stream = _fake_stream

    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[pl, other])):
        with patch("app.main.httpx.AsyncClient", _FakeClient):
            with patch("app.main.health.claude_available", return_value=False):
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                    h = await c.get("/api/health")
                    assert h.json()["ai"] is False

                    d = await c.get("/api/digest?build=true")
                    assert d.json()["count"] == 1
                    assert d.json()["papers"][0]["arxiv_id"] == "99"

                    p = await c.get("/api/papers/99")
                    assert p.json()["title"] == "Title"

                    f = await c.get("/api/pdf/99")
                    assert f.headers["content-type"] == "application/pdf"
                    assert f.content == pdf_bytes
