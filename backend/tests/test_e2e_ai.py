import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app import db, papers
from app.arxiv import Paper
from app.main import app


@pytest.mark.asyncio
async def test_full_ai_round_trip(atlas_data_dir, fixtures_dir):
    """Build digest with AI tiering, summarize one paper, ask a follow-up.

    All AI calls now route through `ai_backend.run_ai`; we dispatch fake
    outputs based on the `task` kwarg (rank/summarize/ask).

    Chat is ephemeral (no DB writes from the asker), so /api/conversations
    returns an empty list — expected.
    """
    db.init()

    pl = [Paper("zz", "MLIR Linalg", "A", "abstract", "cs.PL", "2026-04-19T08:00:00Z")]

    async def fake_run_ai(**kwargs):
        task = kwargs.get("task")
        if task == "rank":
            yield '[{"id":"zz","score":5}]'
        elif task == "summarize":
            yield "## 1. Background\nstuff\n"
        elif task == "ask":
            yield "answer"
        else:
            yield ""

    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[pl, []])), \
         patch("app.digest.health.claude_available", return_value=True), \
         patch("app.main.health.claude_available", return_value=True), \
         patch("app.ranker.ai_backend.run_ai", fake_run_ai), \
         patch("app.summarizer.ai_backend.run_ai", fake_run_ai), \
         patch("app.asker.ai_backend.run_ai", fake_run_ai), \
         patch("app.summarizer.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/zz.pdf")), \
         patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/zz.pdf")):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            d = await c.get("/api/digest?build=true")
            assert d.json()["count"] == 1
            row = papers.get("zz")
            assert row["ai_tier"] == 5

            import json as _json
            s = await c.post("/api/summarize/zz")
            assert f'data: {_json.dumps({"t": "## 1. Background\nstuff\n"})}' in s.text

            a = await c.post("/api/ask/zz", json={"question": "Why?", "history": []})
            assert f'data: {_json.dumps({"t": "answer"})}' in a.text

            conv = await c.get("/api/conversations/zz")
            roles = [m["role"] for m in conv.json()["messages"]]
            assert roles == []
