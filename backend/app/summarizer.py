"""Stream a 10-section deep summary of a paper.

Routes through `ai_backend.run_ai`, which picks claude/codex and host/proxy.
"""

from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator, Optional

from app import ai_backend, papers, pdf_fetch


TEMPLATE_PATH = Path(__file__).parent / "prompts" / "summary_template.txt"


async def summarize(
    arxiv_id: str,
    *,
    backend: str = ai_backend.DEFAULT_BACKEND,
    model: Optional[str] = None,
) -> AsyncIterator[str]:
    """Yield chunks of a deep summary for the paper. Raises KeyError if missing."""
    if papers.get(arxiv_id) is None:
        raise KeyError(arxiv_id)

    async with pdf_fetch.paper_pdf_for_ai(arxiv_id) as pdf_path:
        template = TEMPLATE_PATH.read_text()
        prompt = (
            f"PDF: {pdf_path}\n\n"
            f"Use the Read tool to read the PDF, then produce the structured summary "
            f"per the template below.\n\n{template}"
        )

        async for chunk in ai_backend.run_ai(
            backend=ai_backend.normalize_backend(backend),
            task="summarize",
            directive="Produce the deep summary.",
            prompt=prompt,
            model=model,
            enable_read_file=str(pdf_path),
        ):
            yield chunk
