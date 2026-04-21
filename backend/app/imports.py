"""Import arbitrary PDFs into Atlas — by URL or by direct upload.

Imported papers get a synthetic id of the form `custom-<12-char-sha256>`.
Content-addressed, so re-importing the same PDF is idempotent. The PDF file
lives at `data_dir/pdfs/<id>.pdf`; the `papers` row carries minimal metadata
(title from URL filename, or the uploaded filename) so it shows up in the
digest / search alongside arXiv papers.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Tuple
from urllib.parse import unquote, urlparse

import httpx

from app import db, papers
from app.arxiv import Paper


log = logging.getLogger(__name__)

MAX_PDF_BYTES = 50 * 1024 * 1024       # 50 MB hard cap
PDF_MAGIC = b"%PDF"

# Anything with this id prefix skips the arXiv code paths — we serve from the
# local cache only.
CUSTOM_ID_PREFIX = "custom-"


def is_custom_id(arxiv_id: str) -> bool:
    return arxiv_id.startswith(CUSTOM_ID_PREFIX)


def _synthetic_id(pdf_bytes: bytes) -> str:
    """Content-addressed id. Re-importing the same PDF reuses the same row."""
    sha = hashlib.sha256(pdf_bytes).hexdigest()[:12]
    return f"{CUSTOM_ID_PREFIX}{sha}"


def _store_pdf(arxiv_id: str, pdf_bytes: bytes) -> Path:
    """Write `pdf_bytes` to `data_dir/pdfs/<id>.pdf` atomically."""
    target = db.data_dir() / "pdfs" / f"{arxiv_id}.pdf"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".pdf.part")
    tmp.write_bytes(pdf_bytes)
    tmp.replace(target)
    return target


def _title_from_url(url: str) -> str:
    parsed = urlparse(url)
    # Prefer the last path segment (filename) if it looks like a .pdf, else
    # fall back to the hostname so the paper list still has something readable.
    last = unquote(parsed.path.rsplit("/", 1)[-1]).strip()
    if last.lower().endswith(".pdf"):
        last = last[:-4]
    if last:
        return last.replace("_", " ").replace("-", " ").strip()
    return parsed.netloc or url


def _title_from_filename(filename: str) -> str:
    stem = filename.rsplit("/", 1)[-1]
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    return stem.replace("_", " ").replace("-", " ").strip() or "Uploaded PDF"


def _persist_paper(
    arxiv_id: str,
    *,
    title: str,
    origin: str,      # "URL: https://..." or "Upload: filename.pdf"
) -> Paper:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    paper = Paper(
        arxiv_id=arxiv_id,
        title=title or "Imported PDF",
        authors=origin,
        abstract="",
        categories="custom",
        published=now,
    )
    papers.upsert([paper])
    pdf_path = db.data_dir() / "pdfs" / f"{arxiv_id}.pdf"
    if pdf_path.exists():
        papers.set_pdf_path(arxiv_id, str(pdf_path))
    return paper


class ImportError(RuntimeError):
    """Raised on a recoverable import failure (bad URL, not a PDF, too big)."""


async def import_from_url(url: str, timeout_s: float = 60.0) -> Tuple[str, Paper]:
    """Fetch the PDF at `url`, store it, and create a paper row.

    Raises `ImportError` with a user-friendly message on any failure.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ImportError("URL must start with http:// or https://")

    try:
        async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as client:
            resp = await client.get(url)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise ImportError(f"Could not reach {parsed.netloc} ({type(exc).__name__})") from exc

    if resp.status_code >= 400:
        raise ImportError(f"{parsed.netloc} returned HTTP {resp.status_code}")

    content = resp.content
    if len(content) > MAX_PDF_BYTES:
        raise ImportError(f"PDF exceeds {MAX_PDF_BYTES // (1024 * 1024)} MB limit")
    if not content.startswith(PDF_MAGIC):
        # Tell the user what we got so they can adjust the URL (often an HTML
        # abstract page instead of the direct PDF).
        ctype = resp.headers.get("content-type", "?")
        raise ImportError(f"URL did not serve a PDF (content-type: {ctype})")

    arxiv_id = _synthetic_id(content)
    _store_pdf(arxiv_id, content)
    paper = _persist_paper(arxiv_id, title=_title_from_url(url), origin=f"URL: {url}")
    log.info("import-url ok id=%s bytes=%d", arxiv_id, len(content))
    return arxiv_id, paper


def import_from_upload(filename: str, pdf_bytes: bytes) -> Tuple[str, Paper]:
    """Store a client-uploaded PDF and create a paper row.

    Raises `ImportError` on size/magic failure.
    """
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise ImportError(f"PDF exceeds {MAX_PDF_BYTES // (1024 * 1024)} MB limit")
    if not pdf_bytes.startswith(PDF_MAGIC):
        raise ImportError("Uploaded file is not a PDF")

    arxiv_id = _synthetic_id(pdf_bytes)
    _store_pdf(arxiv_id, pdf_bytes)
    paper = _persist_paper(
        arxiv_id,
        title=_title_from_filename(filename),
        origin=f"Upload: {filename}",
    )
    log.info("import-upload ok id=%s bytes=%d", arxiv_id, len(pdf_bytes))
    return arxiv_id, paper
