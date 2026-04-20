import pytest
from unittest.mock import AsyncMock, patch

from app import asker, db, papers
from app.arxiv import Paper


SAMPLE = Paper("7", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


@pytest.mark.asyncio
async def test_ask_yields_chunks(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(args, stdin_text=None):
        yield "X is "
        yield "a thing.\n"

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.claude_subprocess.run_streaming", _fake):
            chunks = [c async for c in asker.ask("7", "What is X?", history=[])]

    assert "".join(chunks) == "X is a thing.\n"


@pytest.mark.asyncio
async def test_ask_passes_sonnet_model_and_history_in_prompt(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured = {}

    async def _capture(args, stdin_text=None):
        captured["args"] = list(args)
        captured["stdin"] = stdin_text
        yield ""

    history = [
        {"role": "user", "content": "Earlier Q"},
        {"role": "assistant", "content": "Earlier A"},
    ]

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.claude_subprocess.run_streaming", _capture):
            async for _ in asker.ask("7", "New Q", history=history):
                pass

    assert "--model" in captured["args"] and "sonnet" in captured["args"]
    assert "Earlier Q" in captured["stdin"]
    assert "Earlier A" in captured["stdin"]
    assert "New Q" in captured["stdin"]
    assert "/tmp/7.pdf" in captured["stdin"]


@pytest.mark.asyncio
async def test_ask_passes_model_arg(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured = {}

    async def _capture(args, stdin_text=None):
        captured["args"] = list(args)
        yield ""

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.claude_subprocess.run_streaming", _capture):
            async for _ in asker.ask("7", "Q", history=[], model="haiku"):
                pass

    assert "haiku" in captured["args"]


@pytest.mark.asyncio
async def test_ask_propagates_subprocess_error(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _broken(args, stdin_text=None):
        yield "partial"
        from app.claude_subprocess import ClaudeSubprocessError
        raise ClaudeSubprocessError("nope")

    with patch("app.asker.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/7.pdf")):
        with patch("app.asker.claude_subprocess.run_streaming", _broken):
            with pytest.raises(Exception):
                async for _ in asker.ask("7", "Q", history=[]):
                    pass
