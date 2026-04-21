import pytest
from unittest.mock import patch

from app import db, papers, ranker
from app.arxiv import Paper


SAMPLES = [
    Paper("1", "MLIR for X", "A", "abstract one", "cs.PL", "2026-04-19T08:00:00Z"),
    Paper("2", "NLP Survey",  "B", "abstract two", "cs.CL", "2026-04-19T08:00:00Z"),
]


async def _fake_stream(**kwargs):
    yield '[{"id":"1","score":5},'
    yield '{"id":"2","score":1}]'


@pytest.mark.asyncio
async def test_score_papers_writes_tier_and_score(atlas_data_dir):
    db.init()
    papers.upsert(SAMPLES)

    with patch("app.ranker.ai_backend.run_ai", _fake_stream):
        await ranker.score_papers(SAMPLES)

    row1 = papers.get("1")
    row2 = papers.get("2")
    assert row1["ai_score"] == 5.0
    assert row1["ai_tier"] == 5
    assert row2["ai_score"] == 1.0
    assert row2["ai_tier"] == 1


@pytest.mark.asyncio
async def test_score_papers_passes_rank_task_and_prompt(atlas_data_dir):
    db.init()
    papers.upsert(SAMPLES)
    captured: dict = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        yield "[]"

    with patch("app.ranker.ai_backend.run_ai", _capture):
        await ranker.score_papers(SAMPLES)

    assert captured["task"] == "rank"
    assert captured["directive"] == "Score the papers below."
    assert "MLIR for X" in captured["prompt"]
    assert "NLP Survey" in captured["prompt"]


@pytest.mark.asyncio
async def test_score_papers_no_op_on_empty_list(atlas_data_dir):
    db.init()
    called = False

    async def _never(**kwargs):
        nonlocal called
        called = True
        if False:
            yield ""

    with patch("app.ranker.ai_backend.run_ai", _never):
        await ranker.score_papers([])

    assert called is False


@pytest.mark.asyncio
async def test_score_papers_tolerates_malformed_json(atlas_data_dir):
    db.init()
    papers.upsert(SAMPLES)

    async def _bad(**kwargs):
        yield "this is not json"

    with patch("app.ranker.ai_backend.run_ai", _bad):
        await ranker.score_papers(SAMPLES)

    assert papers.get("1")["ai_tier"] is None
