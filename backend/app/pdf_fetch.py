"""On-demand PDF fetcher with no on-disk cache for arXiv papers.

The AI tasks (summarizer / asker / glossary / podcast) need a real filesystem
path to hand to the runner via ``enable_read_file``. arXiv PDFs are public
and cheap to refetch, so we download into a per-call temp file under
``ATLAS_DATA_DIR/tmp/`` and delete it on context exit. Custom uploads / URL
imports keep their persisted file in ``pdfs/`` (created by ``imports.py``).

Single entry point for callers:

    async with paper_pdf_for_ai(arxiv_id) as pdf_path:
        ... use pdf_path ...

The runner's `enable_read_file` validator allows either ``pdfs/`` or
``tmp/`` only — so this is the one and only way an AI call can name a PDF
on disk.
"""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx

from app import db, imports, papers


log = logging.getLogger(__name__)

PDF_URL_TEMPLATE = "https://arxiv.org/pdf/{arxiv_id}"
_FETCH_TIMEOUT_S = 60.0


def _tmp_dir() -> Path:
    p = db.data_dir() / "tmp"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _custom_pdf_path(arxiv_id: str) -> Path:
    return db.data_dir() / "pdfs" / f"{arxiv_id}.pdf"


async def _download_to(target: Path, arxiv_id: str) -> None:
    """Download the arXiv PDF for `arxiv_id` to `target`. Atomic-replace so a
    crash mid-write never leaves a half-written file behind."""
    url = PDF_URL_TEMPLATE.format(arxiv_id=arxiv_id)
    async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        if not resp.content.startswith(b"%PDF"):
            raise ValueError(
                f"arXiv returned non-PDF for {arxiv_id} "
                f"(first 20 bytes: {resp.content[:20]!r})"
            )
        tmp = target.with_suffix(target.suffix + ".part")
        tmp.write_bytes(resp.content)
        tmp.replace(target)


@asynccontextmanager
async def paper_pdf_for_ai(arxiv_id: str) -> AsyncIterator[Path]:
    """Yield a path to the PDF for `arxiv_id` for the lifetime of the block.

    - Custom uploads / URL imports (``custom-`` prefix): the persisted file
      under ``pdfs/`` — no fetch, no cleanup.
    - arXiv ids: a unique file under ``tmp/``, downloaded fresh for this
      call and deleted when the context exits. The runner's
      ``enable_read_file`` validator allows ``tmp/`` so the AI Read tool
      can open it; nothing else under ``ATLAS_DATA_DIR`` is reachable.
    """
    if imports.is_custom_id(arxiv_id):
        path = _custom_pdf_path(arxiv_id)
        if not path.exists():
            raise FileNotFoundError(
                f"custom PDF missing on disk for {arxiv_id}: {path}"
            )
        # Refresh the papers row so consumers (e.g. /api/papers) see the
        # current path. No-op if the row already points here.
        if papers.get(arxiv_id) is not None:
            papers.set_pdf_path(arxiv_id, str(path))
        yield path
        return

    # arXiv path: ephemeral temp file. Unique suffix avoids collisions when
    # two concurrent AI calls hit the same paper.
    tmp = _tmp_dir() / f"{arxiv_id}-{uuid.uuid4().hex[:8]}.pdf"
    try:
        await _download_to(tmp, arxiv_id)
        yield tmp
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        except OSError as exc:
            # Don't let a cleanup hiccup mask a real exception from the body.
            log.warning("failed to remove temp PDF %s: %s", tmp, exc)
