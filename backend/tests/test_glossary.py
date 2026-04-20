import pytest
from unittest.mock import patch

from app import db, glossary, papers
from app.arxiv import Paper


SAMPLE = Paper(
    "g1",
    "Title",
    "Author",
    "An MLIR-based DSL for tiling polyhedral kernels with autotuning.",
    "cs.PL",
    "2026-04-19T08:00:00Z",
)


@pytest.mark.asyncio
async def test_extract_terms_parses_json_array_and_persists(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(args, stdin_text=None):
        yield '["MLIR", "DSL", "tiling", "polyhedral", "autotuning"]'

    with patch("app.glossary.claude_subprocess.run_streaming", _fake):
        terms = await glossary.extract_terms("g1")

    assert terms == ["MLIR", "DSL", "tiling", "polyhedral", "autotuning"]
    rows = glossary.list_for("g1")
    assert [r["term"] for r in rows] == ["MLIR", "DSL", "tiling", "polyhedral", "autotuning"]
    # Definitions are NULL until on-demand fetch.
    assert all(r["definition"] is None for r in rows)


@pytest.mark.asyncio
async def test_extract_terms_strips_code_fence(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(args, stdin_text=None):
        yield '```json\n["MLIR", "DSL"]\n```'

    with patch("app.glossary.claude_subprocess.run_streaming", _fake):
        terms = await glossary.extract_terms("g1")

    assert terms == ["MLIR", "DSL"]


@pytest.mark.asyncio
async def test_extract_terms_falls_back_to_substring(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(args, stdin_text=None):
        yield 'Sure, here are terms: ["one", "two"] hope that helps.'

    with patch("app.glossary.claude_subprocess.run_streaming", _fake):
        terms = await glossary.extract_terms("g1")

    assert terms == ["one", "two"]


@pytest.mark.asyncio
async def test_extract_terms_idempotent_preserves_definitions(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(args, stdin_text=None):
        yield '["MLIR", "DSL"]'

    with patch("app.glossary.claude_subprocess.run_streaming", _fake):
        await glossary.extract_terms("g1")

    # Manually set a cached definition on one row, then re-extract.
    with db.connect() as conn:
        conn.execute(
            "UPDATE glossary SET definition = ? WHERE arxiv_id = ? AND term = ?",
            ("a one-line def", "g1", "MLIR"),
        )

    with patch("app.glossary.claude_subprocess.run_streaming", _fake):
        await glossary.extract_terms("g1")

    rows = {r["term"]: r["definition"] for r in glossary.list_for("g1")}
    assert rows["MLIR"] == "a one-line def"  # not clobbered by re-extract
    assert rows["DSL"] is None


@pytest.mark.asyncio
async def test_extract_terms_unknown_paper_raises(atlas_data_dir):
    db.init()
    with pytest.raises(KeyError):
        await glossary.extract_terms("missing")


@pytest.mark.asyncio
async def test_define_returns_cached_without_calling_claude(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO glossary (arxiv_id, term, definition) VALUES (?, ?, ?)",
            ("g1", "MLIR", "Multi-Level IR framework."),
        )

    async def _should_not_be_called(args, stdin_text=None):
        raise AssertionError("define should not call Claude when cached")
        yield ""  # pragma: no cover - never reached

    with patch("app.glossary.claude_subprocess.run_streaming", _should_not_be_called):
        text = await glossary.define("g1", "MLIR")

    assert text == "Multi-Level IR framework."


@pytest.mark.asyncio
async def test_define_generates_and_persists(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    # Pre-insert with NULL definition (the normal post-extract state).
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO glossary (arxiv_id, term) VALUES (?, ?)",
            ("g1", "tiling"),
        )

    async def _fake(args, stdin_text=None):
        yield "Splitting a loop nest into smaller blocks for cache reuse."

    with patch("app.glossary.claude_subprocess.run_streaming", _fake):
        text = await glossary.define("g1", "tiling")

    assert text.startswith("Splitting a loop nest")
    rows = {r["term"]: r["definition"] for r in glossary.list_for("g1")}
    assert rows["tiling"].startswith("Splitting a loop nest")


@pytest.mark.asyncio
async def test_define_inserts_row_when_term_was_never_extracted(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(args, stdin_text=None):
        yield "A novel term explanation."

    with patch("app.glossary.claude_subprocess.run_streaming", _fake):
        text = await glossary.define("g1", "BrandNewTerm")

    assert text == "A novel term explanation."
    rows = glossary.list_for("g1")
    assert any(r["term"] == "BrandNewTerm" for r in rows)


def test_list_for_returns_empty_for_unknown_paper(atlas_data_dir):
    db.init()
    assert glossary.list_for("never-seen") == []
