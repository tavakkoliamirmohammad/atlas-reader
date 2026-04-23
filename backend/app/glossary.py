"""Per-paper LLM-generated glossary repository.

Two operations talk to an AI backend (default codex):
- `extract_terms` reads the paper's PDF (via the AI's Read tool) and returns
  a JSON array of jargon/system/concept terms, persisted with NULL
  definitions.
- `define` lazily generates a one-line explainer for a single term and
  persists it so subsequent hovers are free.
"""

from __future__ import annotations

import json
import sqlite3
from typing import List, Optional

from app import ai_backend, db, papers, pdf_cache


_EXTRACT_PROMPT = (
    "Use the Read tool to scan the PDF, then extract 6-10 technical terms "
    "(compiler/MLIR/DSL jargon, system names, novel concepts, or acronyms "
    "the paper defines) that would benefit from a 1-line explainer. Output "
    "a JSON array of strings, no prose. No code fences, no commentary."
)


async def _run_text(
    directive: str,
    prompt: str,
    backend: str = ai_backend.DEFAULT_BACKEND,
    *,
    enable_read_file: Optional[str] = None,
) -> str:
    """Collect every chunk from ai_backend.run_ai into one string."""
    parts: list[str] = []
    async for chunk in ai_backend.run_ai(
        backend=ai_backend.normalize_backend(backend),
        task="glossary",
        directive=directive,
        prompt=prompt,
        enable_read_file=enable_read_file,
    ):
        parts.append(chunk)
    return "".join(parts)


def _clean_definition(raw: str, term: str) -> str:
    """Strip meta-preamble from a definition.

    Models sometimes prepend lines like "Using the Superpowers workflow to
    keep the response constrained..." or "Here's the definition:" before the
    actual sentence. We split on sentence boundaries and return from the
    first sentence that contains the term (case-insensitive substring).
    Falls back to stripping the last sentence if the term isn't found.
    """
    import re

    text = raw.strip()
    # Strip code fences and optional language tag (```json, ```text, etc.).
    if text.startswith("```"):
        text = text.strip("`").strip()
        first_nl = text.find("\n")
        if first_nl != -1 and len(text[:first_nl].split()) <= 1:
            text = text[first_nl + 1 :]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    # Split into sentences on ". " keeping the period. Naive but good enough.
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if not sentences:
        return text

    # Normalize term for lookup — lowercase, collapse whitespace, strip punct.
    term_norm = re.sub(r"\s+", " ", term.strip().lower())
    # Also try a dash-less variant so "chiplet-task" matches "chiplet task".
    term_loose = term_norm.replace("-", " ").replace("_", " ")

    def _contains_term(s: str) -> bool:
        sl = s.lower()
        return term_norm in sl or term_loose in re.sub(r"[-_]", " ", sl)

    for i, s in enumerate(sentences):
        if _contains_term(s):
            return " ".join(sentences[i:]).strip()

    # Term never appears — last sentence is usually the least-meta one.
    return sentences[-1]


def _parse_terms(raw: str) -> list[str]:
    """Best-effort JSON-array parse of the extractor output.

    The model is instructed to emit a bare JSON array. We trim whitespace and,
    if needed, scan for the first `[ ... ]` substring as a fallback.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1 or end <= start:
            return []
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return []
    if not isinstance(data, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, str):
            continue
        term = item.strip()
        if not term or term.lower() in seen:
            continue
        seen.add(term.lower())
        out.append(term)
    return out


async def extract_terms(
    arxiv_id: str,
    *,
    backend: str = ai_backend.DEFAULT_BACKEND,
) -> list[str]:
    """Ask the AI for technical terms in this paper's abstract; persist them.

    Existing rows with the same (arxiv_id, term) are preserved via ON CONFLICT
    IGNORE so re-running is idempotent and does not clobber cached definitions.
    """
    paper = papers.get(arxiv_id)
    if paper is None:
        raise KeyError(arxiv_id)

    pdf_path = await pdf_cache.ensure_cached(arxiv_id)
    prompt = f"PDF: {pdf_path}\n\n{_EXTRACT_PROMPT}"
    raw = await _run_text(
        "Extract terms as a JSON array.",
        prompt,
        backend=backend,
        enable_read_file=str(pdf_path),
    )
    terms = _parse_terms(raw)
    if not terms:
        return []

    with db.connect() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO glossary (arxiv_id, term) VALUES (?, ?)",
            [(arxiv_id, t) for t in terms],
        )
    return terms


async def define(
    arxiv_id: str,
    term: str,
    *,
    backend: str = ai_backend.DEFAULT_BACKEND,
) -> str:
    """Return the cached definition for `term`, or generate + persist one."""
    if papers.get(arxiv_id) is None:
        raise KeyError(arxiv_id)

    with db.connect() as conn:
        cur = conn.execute(
            "SELECT definition FROM glossary WHERE arxiv_id = ? AND term = ?",
            (arxiv_id, term),
        )
        row = cur.fetchone()
        if row is not None and row["definition"]:
            return row["definition"]

    prompt = (
        f"Define '{term}' for a compilers PhD student in ONE sentence (max "
        f"25 words).\n\n"
        f"Respond ONLY with the sentence. Start with the term itself or a "
        f"noun phrase. No preamble, no meta-commentary, no 'I'll now define', "
        f"no 'Here is', no 'Using the', no workflow narration, no tool "
        f"narration, no closing remarks. Just the sentence."
    )
    raw = await _run_text("Define the term.", prompt, backend=backend)
    definition = _clean_definition(raw, term)
    if not definition:
        definition = f"(no definition available for '{term}')"

    with db.connect() as conn:
        conn.execute(
            "INSERT INTO glossary (arxiv_id, term, definition) VALUES (?, ?, ?) "
            "ON CONFLICT(arxiv_id, term) DO UPDATE SET definition=excluded.definition",
            (arxiv_id, term, definition),
        )
    return definition


def list_for(arxiv_id: str) -> List[sqlite3.Row]:
    """Return all glossary rows for a paper, oldest first (insertion order)."""
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, term, definition, created_at "
            "FROM glossary WHERE arxiv_id = ? ORDER BY id ASC",
            (arxiv_id,),
        )
        return list(cur.fetchall())
