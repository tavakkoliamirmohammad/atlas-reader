import pytest
from unittest.mock import AsyncMock, patch

from app import db, papers, summarizer
from app.arxiv import Paper


SAMPLE = Paper("9", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


@pytest.mark.asyncio
async def test_summarize_yields_chunks(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(args, stdin_text=None):
        yield "## 1. Background\n"
        yield "blah\n"
        yield "## 2. Problem\n"

    with patch("app.summarizer.pdf_cache.ensure_cached", new=AsyncMock()):
        with patch("app.summarizer.claude_subprocess.run_streaming", _fake):
            chunks = [c async for c in summarizer.summarize("9")]

    assert chunks == ["## 1. Background\n", "blah\n", "## 2. Problem\n"]


@pytest.mark.asyncio
async def test_summarize_uses_opus_with_max_effort(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured = {}

    async def _capture(args, stdin_text=None):
        captured["args"] = list(args)
        captured["stdin"] = stdin_text
        yield ""

    with patch("app.summarizer.pdf_cache.ensure_cached",
               new=AsyncMock(return_value="/tmp/9.pdf")):
        with patch("app.summarizer.claude_subprocess.run_streaming", _capture):
            async for _ in summarizer.summarize("9"):
                pass

    assert "--model" in captured["args"] and "opus" in captured["args"]
    assert "--effort" in captured["args"] and "max" in captured["args"]
    assert "/tmp/9.pdf" in captured["stdin"]
    assert "## 1. Background" in captured["stdin"]


@pytest.mark.asyncio
async def test_summarize_404s_for_unknown_paper(atlas_data_dir):
    db.init()
    with pytest.raises(KeyError):
        async for _ in summarizer.summarize("missing"):
            pass


@pytest.mark.asyncio
async def test_summarize_passes_model_arg(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured = {}

    async def _capture(args, stdin_text=None):
        captured["args"] = list(args)
        yield ""

    with patch("app.summarizer.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/9.pdf")):
        with patch("app.summarizer.claude_subprocess.run_streaming", _capture):
            async for _ in summarizer.summarize("9", model="haiku"):
                pass

    assert "haiku" in captured["args"]
    # cheaper models should not pass --effort
    assert "--effort" not in captured["args"]


@pytest.mark.asyncio
async def test_summarize_sonnet_drops_effort_flag(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured = {}

    async def _capture(args, stdin_text=None):
        captured["args"] = list(args)
        yield ""

    with patch("app.summarizer.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/9.pdf")):
        with patch("app.summarizer.claude_subprocess.run_streaming", _capture):
            async for _ in summarizer.summarize("9", model="sonnet"):
                pass

    assert "sonnet" in captured["args"]
    assert "--effort" not in captured["args"]
