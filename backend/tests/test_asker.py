import pytest
from unittest.mock import AsyncMock, patch

from app import asker, db, papers
from app.arxiv import Paper


SAMPLE = Paper("7", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


@pytest.mark.asyncio
async def test_ask_yields_chunks(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield "X is "
        yield "a thing.\n"

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.ai_backend.run_ai", _fake):
            chunks = [c async for c in asker.ask("7", "What is X?", history=[])]

    assert "".join(chunks) == "X is a thing.\n"


@pytest.mark.asyncio
async def test_ask_passes_ask_task_and_history_in_prompt(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured: dict = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        yield ""

    history = [
        {"role": "user", "content": "Earlier Q"},
        {"role": "assistant", "content": "Earlier A"},
    ]

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.ai_backend.run_ai", _capture):
            async for _ in asker.ask("7", "New Q", history=history):
                pass

    assert captured["task"] == "ask"
    assert captured["directive"] == "Answer the question."
    assert "Earlier Q" in captured["prompt"]
    assert "Earlier A" in captured["prompt"]
    assert "New Q" in captured["prompt"]
    assert "/tmp/7.pdf" in captured["prompt"]
    assert captured["enable_read_file"] == "/tmp/7.pdf"


@pytest.mark.asyncio
async def test_ask_passes_model_override(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured: dict = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        yield ""

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.ai_backend.run_ai", _capture):
            async for _ in asker.ask("7", "Q", history=[], model="haiku", backend="claude"):
                pass

    assert captured["model"] == "haiku"
    assert captured["backend"] == "claude"


@pytest.mark.asyncio
async def test_ask_propagates_subprocess_error(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _broken(**kwargs):
        yield "partial"
        raise RuntimeError("nope")

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.ai_backend.run_ai", _broken):
            with pytest.raises(Exception):
                async for _ in asker.ask("7", "Q", history=[]):
                    pass
