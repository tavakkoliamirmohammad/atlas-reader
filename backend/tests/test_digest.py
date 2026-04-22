import pytest
from unittest.mock import AsyncMock, patch

from app import db, digest, papers
from app.arxiv import Paper


def _make(aid: str, title: str, cat: str) -> Paper:
    return Paper(aid, title, "A", "<abstract discarded>", cat, "2026-04-19T08:00:00Z")


@pytest.mark.asyncio
async def test_build_fetches_all_categories_and_persists(atlas_data_dir):
    db.init()
    # digest fetches in this order: cs.PL, cs.AR, cs.DC, cs.PF, cs.LG.
    responses = [
        [_make("pl-1", "Type inference for Rust", "cs.PL")],
        [_make("ar-1", "MLIR dialect for FPGAs", "cs.AR")],
        [_make("dc-1", "Compiler IR for distributed training", "cs.DC")],
        [_make("pf-1", "Roofline analysis on Triton kernels", "cs.PF")],
        [_make("lg-1", "A TVM autotuner for transformers", "cs.LG")],
    ]
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=responses)):
        result = await digest.build_today()

    assert {r["arxiv_id"] for r in result} == {"pl-1", "ar-1", "dc-1", "pf-1", "lg-1"}


@pytest.mark.asyncio
async def test_build_admits_every_paper_regardless_of_title(atlas_data_dir):
    db.init()
    # The pipeline is intentionally filter-free — users search, not guess
    # which papers match our keyword list.
    responses = [
        [_make("pl-1", "Algebraic subtyping", "cs.PL")],
        [_make("ar-1", "Megakernels on Multi-Die GPUs", "cs.AR")],     # would fail \bGPU\b
        [_make("dc-1", "Distributed tensor fusion at scale", "cs.DC")],
        [_make("pf-1", "Benchmarking Redis under high load", "cs.PF")],
        [_make("lg-1", "Transformer inference latency", "cs.LG")],
    ]
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=responses)):
        result = await digest.build_today()

    ids = {r["arxiv_id"] for r in result}
    assert ids == {"pl-1", "ar-1", "dc-1", "pf-1", "lg-1"}


@pytest.mark.asyncio
async def test_build_records_partial_status_when_some_categories_fail(atlas_data_dir):
    db.init()
    # cs.AR raises, everything else returns one paper. Partial success still
    # persists the surviving results.
    responses = [
        [_make("pl-1", "Compiler IR design", "cs.PL")],
        RuntimeError("arxiv timeout"),
        [_make("dc-1", "Compiler for tensor ops", "cs.DC")],
        [_make("pf-1", "Roofline on CUDA", "cs.PF")],
        [_make("lg-1", "TVM autotuning", "cs.LG")],
    ]
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=responses)):
        await digest.build_today()

    with db.connect() as conn:
        row = conn.execute("SELECT status, paper_count, log FROM builds").fetchone()
    assert row["status"] == "partial"
    assert row["paper_count"] == 4
    assert "cs.AR" in row["log"]


@pytest.mark.asyncio
async def test_build_records_failed_when_all_categories_fail(atlas_data_dir):
    db.init()
    responses = [RuntimeError("arxiv down")] * 5
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=responses)):
        rows = await digest.build_today()

    with db.connect() as conn:
        row = conn.execute("SELECT status, paper_count FROM builds").fetchone()
    assert row["status"] == "failed"
    assert row["paper_count"] == 0
    assert rows == []  # no cache yet


@pytest.mark.asyncio
async def test_build_does_not_wipe_existing_cache_on_total_failure(atlas_data_dir):
    """Prior papers stay visible even when every category fails today."""
    db.init()
    old = _make("cached-1", "Compiler IR", "cs.PL")
    papers.upsert([old])

    responses = [RuntimeError("arxiv down")] * 5
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=responses)):
        rows = await digest.build_today()

    ids = {r["arxiv_id"] for r in rows}
    assert "cached-1" in ids


@pytest.mark.asyncio
async def test_build_writes_status_row_with_timestamps(atlas_data_dir):
    db.init()
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[[]] * 5)):
        await digest.build_today()

    with db.connect() as conn:
        row = conn.execute(
            "SELECT date, status, started_at, finished_at, paper_count FROM builds"
        ).fetchone()
    assert row["status"] == "done"
    assert row["paper_count"] == 0
    assert row["started_at"] is not None
    assert row["finished_at"] is not None
    assert row["started_at"] <= row["finished_at"]


@pytest.mark.asyncio
async def test_build_dedupes_cross_category_duplicates(atlas_data_dir):
    db.init()
    same_id = "shared-1"
    responses = [
        [_make(same_id, "MLIR lowering pipeline", "cs.PL")],
        [_make(same_id, "MLIR lowering pipeline", "cs.AR")],
        [],
        [],
        [],
    ]
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=responses)):
        rows = await digest.build_today()

    assert len([r for r in rows if r["arxiv_id"] == same_id]) == 1


@pytest.mark.asyncio
async def test_build_upsert_stores_empty_abstract(atlas_data_dir):
    """Atlas persists only titles/authors/categories; abstracts are discarded."""
    db.init()
    responses = [
        [_make("zz", "Compiler paper", "cs.PL")],
        [],
        [],
        [],
        [],
    ]
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=responses)):
        await digest.build_today()

    row = papers.get("zz")
    assert row is not None
    assert row["abstract"] == ""
