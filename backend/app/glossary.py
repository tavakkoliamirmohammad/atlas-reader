"""Per-paper LLM-generated glossary repository.

Two operations talk to Claude:
- `extract_terms` runs Sonnet on the abstract once per paper, returns a JSON
  array of term strings, and inserts them with NULL definitions.
- `define` lazily generates a one-line explainer for a single term and
  persists it so subsequent hovers are free.
"""

from __future__ import annotations

import json
import sqlite3
from typing import List, Optional

from app import claude_subprocess, db, papers


_EXTRACT_PROMPT = (
    "From this abstract, extract 5-8 technical terms (compiler/MLIR/DSL "
    "jargon, system names, novel concepts) that would benefit from a "
    "1-line explainer. Output a JSON array of strings, no prose. "
    "No code fences, no commentary."
)


async def _run_text(args: list[str], stdin_text: Optional[str] = None) -> str:
    """Collect every chunk from claude_subprocess.run_streaming into one string."""
    parts: list[str] = []
    async for chunk in claude_subprocess.run_streaming(args, stdin_text=stdin_text):
        parts.append(chunk)
    return "".join(parts)


def _parse_terms(raw: str) -> list[str]:
    """Best-effort JSON-array parse of the extractor output.

    The model is instructed to emit a bare JSON array. We trim whitespace and,
    if needed, scan for the first `[ ... ]` substring as a fallback.
    """
    text = raw.strip()
    # Strip accidental ```json fences.
    if text.startswith("```"):
        text = text.strip("`")
        # Drop a leading 'json' language tag if present.
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


async def extract_terms(arxiv_id: str) -> list[str]:
    """Ask Sonnet for technical terms in this paper's abstract; persist them.

    Returns the list of terms (in insertion order). Existing rows with the same
    (arxiv_id, term) are preserved (UNIQUE constraint, ON CONFLICT IGNORE) so
    re-running extraction is idempotent and does not clobber cached definitions.
    """
    paper = papers.get(arxiv_id)
    if paper is None:
        raise KeyError(arxiv_id)

    abstract = (paper["abstract"] or "").strip()
    if not abstract:
        return []

    prompt = f"ABSTRACT:\n{abstract}\n\n{_EXTRACT_PROMPT}"
    raw = await _run_text(
        ["--model", "sonnet", "-p", "Extract terms as a JSON array."],
        stdin_text=prompt,
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


async def define(arxiv_id: str, term: str) -> str:
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
        f"In ONE sentence (max 25 words), explain '{term}' for a compilers "
        f"PhD student. No preface, no quotes, just the sentence."
    )
    raw = await _run_text(
        ["--model", "sonnet", "-p", "Define the term."],
        stdin_text=prompt,
    )
    definition = raw.strip()
    if not definition:
        definition = f"(no definition available for '{term}')"

    with db.connect() as conn:
        # Upsert: insert if missing (e.g. caller asked about a term that was
        # never extracted), otherwise update the existing row's definition.
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
