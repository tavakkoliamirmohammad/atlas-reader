"""Stream a 10-section deep summary of a paper using `claude -p --model opus`."""

from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator

from app import claude_subprocess, papers, pdf_cache


TEMPLATE_PATH = Path(__file__).parent / "prompts" / "summary_template.txt"


async def summarize(arxiv_id: str) -> AsyncIterator[str]:
    """Yield chunks of a deep summary for the paper. Raises KeyError if missing."""
    if papers.get(arxiv_id) is None:
        raise KeyError(arxiv_id)

    pdf_path = await pdf_cache.ensure_cached(arxiv_id)
    template = TEMPLATE_PATH.read_text()
    prompt = (
        f"PDF: {pdf_path}\n\n"
        f"Use the Read tool to read the PDF, then produce the structured summary "
        f"per the template below.\n\n{template}"
    )

    async for chunk in claude_subprocess.run_streaming(
        ["--model", "opus", "--effort", "max",
         "--allowedTools", "Read",
         "-p", "Produce the deep summary."],
        stdin_text=prompt,
    ):
        yield chunk
