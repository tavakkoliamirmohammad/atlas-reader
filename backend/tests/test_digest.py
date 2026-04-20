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
        rows = list(conn.execute("SELECT date, status FROM builds"))
    assert len(rows) == 1
    assert rows[0]["status"] == "done"
