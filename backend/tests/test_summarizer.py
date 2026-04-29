import pytest
from contextlib import asynccontextmanager
from unittest.mock import patch

from app import db, papers, summarizer
from app.arxiv import Paper


SAMPLE = Paper("9", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


def _stub_pdf(path: str = "/tmp/9.pdf"):
    """Patch the per-call temp-PDF context manager to yield a fixed path."""
    @asynccontextmanager
    async def _fake(_arxiv_id):
        yield path
    return patch("app.summarizer.pdf_fetch.paper_pdf_for_ai", _fake)


@pytest.mark.asyncio
async def test_summarize_yields_chunks(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield "## 1. Background\n"
        yield "blah\n"
        yield "## 2. Problem\n"

    with _stub_pdf(), patch("app.summarizer.ai_backend.run_ai", _fake):
        chunks = [c async for c in summarizer.summarize("9")]

    assert chunks == ["## 1. Background\n", "blah\n", "## 2. Problem\n"]


@pytest.mark.asyncio
async def test_summarize_uses_summarize_task(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured: dict = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        yield ""

    with _stub_pdf("/tmp/9.pdf"), patch("app.summarizer.ai_backend.run_ai", _capture):
        async for _ in summarizer.summarize("9"):
            pass

    assert captured["task"] == "summarize"
    assert captured["directive"] == "Produce the deep summary."
    assert captured["enable_read_file"] == "/tmp/9.pdf"
    assert "/tmp/9.pdf" in captured["prompt"]
    assert "## 1. Background" in captured["prompt"]


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
    captured: dict = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        yield ""

    with _stub_pdf(), patch("app.summarizer.ai_backend.run_ai", _capture):
        async for _ in summarizer.summarize("9", backend="claude", model="haiku"):
            pass

    assert captured["backend"] == "claude"
    assert captured["model"] == "haiku"


@pytest.mark.asyncio
async def test_summarize_defaults_to_codex_backend(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    captured: dict = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        yield ""

    with _stub_pdf(), patch("app.summarizer.ai_backend.run_ai", _capture):
        async for _ in summarizer.summarize("9"):
            pass

    assert captured["backend"] == "codex"
