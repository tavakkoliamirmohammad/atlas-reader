"""Score papers 1-5 by relevance using `claude -p --model haiku`."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterable

from app import claude_subprocess, db
from app.arxiv import Paper


log = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent / "prompts" / "ranker.txt"


def _build_prompt(papers_list: list[Paper]) -> str:
    block = "\n".join(
        f"- id={p.arxiv_id} | {p.title} | {p.abstract[:280]}"
        for p in papers_list
    )
    return PROMPT_PATH.read_text().replace("{papers_block}", block)


async def score_papers(items: Iterable[Paper]) -> None:
    """Score each paper 1-5 and write ai_tier/ai_score to the papers table."""
    items = list(items)
    if not items:
        return

    prompt = _build_prompt(items)
    chunks: list[str] = []
    async for c in claude_subprocess.run_streaming(
        ["--model", "haiku", "-p", "Score the papers below."],
        stdin_text=prompt,
    ):
        chunks.append(c)
    raw = "".join(chunks).strip()

    try:
        scores = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("ranker: could not parse model output as JSON: %r", raw[:200])
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
