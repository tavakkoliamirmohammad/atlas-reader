import pytest
from contextlib import asynccontextmanager
from unittest.mock import patch

from app import asker, db, papers
from app.arxiv import Paper


SAMPLE = Paper("7", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


def _stub_pdf(path: str = "/tmp/7.pdf"):
    @asynccontextmanager
    async def _fake(_arxiv_id):
        yield path
    return patch("app.asker.pdf_fetch.paper_pdf_for_ai", _fake)


@pytest.mark.asyncio
async def test_ask_yields_chunks(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield "X is "
        yield "a thing.\n"

    with _stub_pdf(), patch("app.asker.ai_backend.run_ai", _fake):
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

    with _stub_pdf(), patch("app.asker.ai_backend.run_ai", _capture):
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

    with _stub_pdf(), patch("app.asker.ai_backend.run_ai", _capture):
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

    with _stub_pdf(), patch("app.asker.ai_backend.run_ai", _broken):
        with pytest.raises(Exception):
            async for _ in asker.ask("7", "Q", history=[]):
                pass
