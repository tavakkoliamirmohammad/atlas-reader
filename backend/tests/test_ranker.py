import pytest
from unittest.mock import patch

from app import db, papers, ranker
from app.arxiv import Paper


SAMPLES = [
    Paper("1", "MLIR for X", "A", "abstract one", "cs.PL", "2026-04-19T08:00:00Z"),
    Paper("2", "NLP Survey",  "B", "abstract two", "cs.CL", "2026-04-19T08:00:00Z"),
]


async def _fake_stream(args, stdin_text=None):
    yield '[{"id":"1","score":5},'
    yield '{"id":"2","score":1}]'


@pytest.mark.asyncio
async def test_score_papers_writes_tier_and_score(atlas_data_dir):
    db.init()
    papers.upsert(SAMPLES)

    with patch("app.ranker.claude_subprocess.run_streaming", _fake_stream):
        await ranker.score_papers(SAMPLES)

    row1 = papers.get("1")
    row2 = papers.get("2")
    assert row1["ai_score"] == 5.0
    assert row1["ai_tier"] == 5
    assert row2["ai_score"] == 1.0
    assert row2["ai_tier"] == 1


@pytest.mark.asyncio
async def test_score_papers_passes_haiku_model_and_prompt(atlas_data_dir):
    db.init()
    papers.upsert(SAMPLES)
    spy_args = {}

    async def _capture(args, stdin_text=None):
        spy_args["args"] = list(args)
        spy_args["stdin"] = stdin_text
        yield "[]"

    with patch("app.ranker.claude_subprocess.run_streaming", _capture):
        await ranker.score_papers(SAMPLES)

    assert "--model" in spy_args["args"]
    assert "haiku" in spy_args["args"]
    assert "MLIR for X" in spy_args["stdin"]
    assert "NLP Survey" in spy_args["stdin"]


@pytest.mark.asyncio
async def test_score_papers_no_op_on_empty_list(atlas_data_dir):
    db.init()
    called = False

    async def _never(args, stdin_text=None):
        nonlocal called
        called = True
        if False:
            yield ""

    with patch("app.ranker.claude_subprocess.run_streaming", _never):
        await ranker.score_papers([])

    assert called is False


@pytest.mark.asyncio
async def test_score_papers_tolerates_malformed_json(atlas_data_dir):
    db.init()
    papers.upsert(SAMPLES)

    async def _bad(args, stdin_text=None):
        yield "this is not json"

    with patch("app.ranker.claude_subprocess.run_streaming", _bad):
        await ranker.score_papers(SAMPLES)  # must not raise

    assert papers.get("1")["ai_tier"] is None
