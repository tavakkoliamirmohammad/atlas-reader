import pytest
from unittest.mock import AsyncMock, patch

from app import db, glossary, papers
from app.arxiv import Paper


# extract_terms now reads the paper's PDF via the AI's Read tool. Tests don't
# actually have a PDF on disk, so we mock ensure_cached in every extract_terms
# test below.
def _patch_pdf():
    return patch("app.glossary.pdf_cache.ensure_cached", new=AsyncMock(return_value="/tmp/g1.pdf"))


SAMPLE = Paper(
    "g1",
    "MLIR-based DSL for tiling polyhedral kernels with autotuning",
    "Author",
    "<abstract is not persisted>",
    "cs.PL",
    "2026-04-19T08:00:00Z",
)


@pytest.mark.asyncio
async def test_extract_terms_parses_json_array_and_persists(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield '["MLIR", "DSL", "tiling", "polyhedral", "autotuning"]'

    with _patch_pdf(), patch("app.glossary.ai_backend.run_ai", _fake):
        terms = await glossary.extract_terms("g1")

    assert terms == ["MLIR", "DSL", "tiling", "polyhedral", "autotuning"]
    rows = glossary.list_for("g1")
    assert [r["term"] for r in rows] == ["MLIR", "DSL", "tiling", "polyhedral", "autotuning"]
    assert all(r["definition"] is None for r in rows)


@pytest.mark.asyncio
async def test_extract_terms_strips_code_fence(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield '```json\n["MLIR", "DSL"]\n```'

    with _patch_pdf(), patch("app.glossary.ai_backend.run_ai", _fake):
        terms = await glossary.extract_terms("g1")

    assert terms == ["MLIR", "DSL"]


@pytest.mark.asyncio
async def test_extract_terms_falls_back_to_substring(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield 'Sure, here are terms: ["one", "two"] hope that helps.'

    with _patch_pdf(), patch("app.glossary.ai_backend.run_ai", _fake):
        terms = await glossary.extract_terms("g1")

    assert terms == ["one", "two"]


@pytest.mark.asyncio
async def test_extract_terms_idempotent_preserves_definitions(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield '["MLIR", "DSL"]'

    with _patch_pdf(), patch("app.glossary.ai_backend.run_ai", _fake):
        await glossary.extract_terms("g1")

    with db.connect() as conn:
        conn.execute(
            "UPDATE glossary SET definition = ? WHERE arxiv_id = ? AND term = ?",
            ("a one-line def", "g1", "MLIR"),
        )

    with _patch_pdf(), patch("app.glossary.ai_backend.run_ai", _fake):
        await glossary.extract_terms("g1")

    rows = {r["term"]: r["definition"] for r in glossary.list_for("g1")}
    assert rows["MLIR"] == "a one-line def"
    assert rows["DSL"] is None


@pytest.mark.asyncio
async def test_extract_terms_unknown_paper_raises(atlas_data_dir):
    db.init()
    with pytest.raises(KeyError):
        await glossary.extract_terms("missing")


@pytest.mark.asyncio
async def test_define_returns_cached_without_calling_backend(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO glossary (arxiv_id, term, definition) VALUES (?, ?, ?)",
            ("g1", "MLIR", "Multi-Level IR framework."),
        )

    async def _should_not_be_called(**kwargs):
        raise AssertionError("define should not call the AI when cached")
        yield ""  # pragma: no cover

    with patch("app.glossary.ai_backend.run_ai", _should_not_be_called):
        text = await glossary.define("g1", "MLIR")

    assert text == "Multi-Level IR framework."


@pytest.mark.asyncio
async def test_define_generates_and_persists(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO glossary (arxiv_id, term) VALUES (?, ?)",
            ("g1", "tiling"),
        )

    async def _fake(**kwargs):
        yield "Splitting a loop nest into smaller blocks for cache reuse."

    with patch("app.glossary.ai_backend.run_ai", _fake):
        text = await glossary.define("g1", "tiling")

    assert text.startswith("Splitting a loop nest")
    rows = {r["term"]: r["definition"] for r in glossary.list_for("g1")}
    assert rows["tiling"].startswith("Splitting a loop nest")


@pytest.mark.asyncio
async def test_define_inserts_row_when_term_was_never_extracted(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async def _fake(**kwargs):
        yield "A novel term explanation."

    with patch("app.glossary.ai_backend.run_ai", _fake):
        text = await glossary.define("g1", "BrandNewTerm")

    assert text == "A novel term explanation."
    rows = glossary.list_for("g1")
    assert any(r["term"] == "BrandNewTerm" for r in rows)


def test_list_for_returns_empty_for_unknown_paper(atlas_data_dir):
    db.init()
    assert glossary.list_for("never-seen") == []


# --- _clean_definition ---------------------------------------------------

def test_clean_definition_strips_meta_preamble():
    raw = (
        "Using the Superpowers workflow to keep the response constrained to the "
        "exact format you asked for. Chiplet-task is a compilation unit or work "
        "item designed to be mapped, scheduled, and communicated across multiple "
        "chiplets in a heterogeneous package."
    )
    out = glossary._clean_definition(raw, "Chiplet-task")
    assert out.startswith("Chiplet-task is a compilation unit")
    assert "Superpowers workflow" not in out


def test_clean_definition_returns_full_sentence_when_clean():
    raw = "Infinity Cache is AMD's 256 MB on-package last-level cache shared across chiplets."
    assert glossary._clean_definition(raw, "Infinity Cache") == raw


def test_clean_definition_matches_loose_dashes():
    raw = "Here is the answer. A chiplet task is a unit of work mapped to one chiplet."
    out = glossary._clean_definition(raw, "Chiplet-task")
    assert out.startswith("A chiplet task")


def test_clean_definition_strips_code_fences():
    raw = "```\nFoo is a bar.\n```"
    assert glossary._clean_definition(raw, "Foo") == "Foo is a bar."


def test_clean_definition_falls_back_to_last_sentence_when_term_missing():
    raw = "I'll now explain this. Here is the answer you requested."
    out = glossary._clean_definition(raw, "SomeUnrelatedTerm")
    assert out == "Here is the answer you requested."
