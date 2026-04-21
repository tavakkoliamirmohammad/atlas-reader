import pytest
from unittest.mock import AsyncMock, patch

from app import db, digest, papers
from app.arxiv import Paper


@pytest.mark.asyncio
async def test_build_today_fetches_two_queries_and_persists(atlas_data_dir):
    db.init()
    pl = [Paper("1", "t", "a", "x", "cs.PL", "2026-04-19T08:00:00Z")]
    other = [Paper("2", "t", "a", "x", "cs.AR", "2026-04-19T09:00:00Z")]

    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[pl, other])):
        result = await digest.build_today()

    assert {r["arxiv_id"] for r in result} == {"1", "2"}
    assert papers.get("1") is not None
    assert papers.get("2") is not None


@pytest.mark.asyncio
async def test_build_today_dedupes_overlapping_results(atlas_data_dir):
    db.init()
    same = Paper("dup", "t", "a", "x", "cs.PL", "2026-04-19T08:00:00Z")
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[[same], [same]])):
        result = await digest.build_today()

    assert len(result) == 1
    assert result[0]["arxiv_id"] == "dup"


@pytest.mark.asyncio
async def test_build_today_writes_build_status_row(atlas_data_dir):
    db.init()
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[[], []])):
        await digest.build_today()

    with db.connect() as conn:
        rows = list(conn.execute(
            "SELECT date, status, started_at, finished_at, paper_count FROM builds"
        ))
    assert len(rows) == 1
    assert rows[0]["status"] == "done"
    assert rows[0]["paper_count"] == 0
    assert rows[0]["started_at"] is not None
    assert rows[0]["finished_at"] is not None
    assert rows[0]["started_at"] <= rows[0]["finished_at"]


@pytest.mark.asyncio
async def test_build_today_records_failure_when_fetch_raises(atlas_data_dir):
    """arXiv failures mark the build row as failed but don't propagate — we
    return whatever is already cached so the UI still loads a list.
    """
    db.init()
    with patch(
        "app.digest.arxiv.fetch_recent",
        new=AsyncMock(side_effect=RuntimeError("arxiv down")),
    ):
        rows = await digest.build_today()

    assert rows == []  # nothing cached yet
    with db.connect() as conn:
        build_rows = list(conn.execute("SELECT status, log FROM builds"))
    assert len(build_rows) == 1
    assert build_rows[0]["status"] == "failed"
    assert "RuntimeError" in build_rows[0]["log"]
    assert "arxiv down" in build_rows[0]["log"]


@pytest.mark.asyncio
async def test_build_today_calls_ranker_when_ai_available(atlas_data_dir):
    db.init()
    pl = [Paper("a", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")]

    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[pl, []])):
        with patch("app.digest.health.backend_available", return_value=True):
            with patch("app.digest.ranker.score_papers", new=AsyncMock()) as spy:
                await digest.build_today()

    spy.assert_awaited_once()
    args, kwargs = spy.call_args
    assert args[0][0].arxiv_id == "a"


@pytest.mark.asyncio
async def test_build_today_skips_ranker_when_ai_unavailable(atlas_data_dir):
    db.init()
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[[], []])):
        with patch("app.digest.health.backend_available", return_value=False):
            with patch("app.digest.ranker.score_papers", new=AsyncMock()) as spy:
                await digest.build_today()

    spy.assert_not_awaited()
