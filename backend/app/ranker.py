"""Score papers 1-5 by relevance.

Routes through `ai_backend.run_ai`; uses the default model for the `rank` task
(claude=haiku, codex=gpt-5).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterable

from app import ai_backend, db
from app.arxiv import Paper


log = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent / "prompts" / "ranker.txt"


def _strip_code_fence(raw: str) -> str:
    r"""Strip a leading ``` / ```json fence and trailing ``` if present.

    Models regularly wrap array output in a markdown code fence; json.loads
    fails on the raw fenced string.
    """
    s = raw.strip()
    if s.startswith("```"):
        first_nl = s.find("\n")
        s = s[first_nl + 1 :] if first_nl != -1 else s[3:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def _build_prompt(papers_list: list[Paper]) -> str:
    block = "\n".join(
        f"- id={p.arxiv_id} | {p.title} | {p.abstract[:280]}"
        for p in papers_list
    )
    return PROMPT_PATH.read_text().replace("{papers_block}", block)


async def score_papers(
    items: Iterable[Paper],
    *,
    backend: str = ai_backend.DEFAULT_BACKEND,
) -> None:
    """Score each paper 1-5 and write ai_tier/ai_score to the papers table."""
    items = list(items)
    if not items:
        return

    prompt = _build_prompt(items)
    chunks: list[str] = []
    async for c in ai_backend.run_ai(
        backend=ai_backend.normalize_backend(backend),
        task="rank",
        directive="Score the papers below.",
        prompt=prompt,
    ):
        chunks.append(c)
    raw = "".join(chunks).strip()

    cleaned = _strip_code_fence(raw)

    try:
        scores = json.loads(cleaned)
    except json.JSONDecodeError:
        log.warning("ranker: could not parse model output as JSON: %r", cleaned[:200])
        return

    with db.connect() as conn:
        for entry in scores:
            try:
                aid = entry["id"]
                score = float(entry["score"])
            except (KeyError, TypeError, ValueError):
                continue
            conn.execute(
                "UPDATE papers SET ai_tier = ?, ai_score = ? WHERE arxiv_id = ?",
                (int(round(score)), score, aid),
            )
