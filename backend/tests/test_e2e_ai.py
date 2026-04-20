import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app import db, papers
from app.arxiv import Paper
from app.main import app


@pytest.mark.asyncio
async def test_full_ai_round_trip(atlas_data_dir, fixtures_dir):
    """Build digest with AI tiering, summarize one paper, ask a follow-up.

    Chat is now ephemeral (no DB writes from the asker), so /api/conversations
    returns an empty list — that's the expected behavior, not a bug.
    """
    db.init()

    pl = [Paper("zz", "MLIR Linalg", "A", "abstract", "cs.PL", "2026-04-19T08:00:00Z")]

    # All three modules share the same `app.claude_subprocess.run_streaming`,
    # so we route on the model arg to dispatch ranker/summarizer/asker outputs.
    async def fake_run_streaming(args, stdin_text=None):
        args_list = list(args)
        try:
            model = args_list[args_list.index("--model") + 1]
        except (ValueError, IndexError):
            model = ""
        if model == "haiku":
            yield '[{"id":"zz","score":5}]'
        elif model == "opus":
            yield "## 1. Background\nstuff\n"
        elif model == "sonnet":
            yield "answer"
        else:
            yield ""

    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[pl, []])), \
         patch("app.digest.health.claude_available", return_value=True), \
         patch("app.main.health.claude_available", return_value=True), \
         patch("app.claude_subprocess.run_streaming", fake_run_streaming), \
         patch("app.summarizer.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/zz.pdf")), \
         patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/zz.pdf")):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            # Build digest -> ranker runs
            d = await c.get("/api/digest?build=true")
            assert d.json()["count"] == 1
            row = papers.get("zz")
            assert row["ai_tier"] == 5

            # Summarize -> SSE stream
            s = await c.post("/api/summarize/zz")
            assert "data: ## 1. Background" in s.text

            # Ask -> SSE stream (ephemeral, no DB write)
            a = await c.post("/api/ask/zz", json={"question": "Why?", "history": []})
            assert "data: answer" in a.text

            conv = await c.get("/api/conversations/zz")
            roles = [m["role"] for m in conv.json()["messages"]]
            assert roles == []
