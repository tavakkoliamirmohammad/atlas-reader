"""On-disk PDF cache: fetch from arXiv once, serve from disk forever."""

from __future__ import annotations

from pathlib import Path

import httpx

from app import db, papers


PDF_URL_TEMPLATE = "https://arxiv.org/pdf/{arxiv_id}"


def cache_path(arxiv_id: str) -> Path:
    return db.data_dir() / "pdfs" / f"{arxiv_id}.pdf"


async def ensure_cached(arxiv_id: str, timeout: float = 60.0) -> Path:
    """Return path to the cached PDF, downloading first if needed."""
    target = cache_path(arxiv_id)
    if not target.exists():
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(PDF_URL_TEMPLATE.format(arxiv_id=arxiv_id))
            resp.raise_for_status()
            target.write_bytes(resp.content)
    if papers.get(arxiv_id) is not None:
        papers.set_pdf_path(arxiv_id, str(target))
    return target
