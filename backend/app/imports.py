"""Import arbitrary PDFs into Atlas — by URL or by direct upload.

Imported papers get a synthetic id of the form `custom-<12-char-sha256>`.
Content-addressed, so re-importing the same PDF is idempotent. The PDF file
lives at `data_dir/pdfs/<id>.pdf`; the `papers` row carries minimal metadata
(title from URL filename, or the uploaded filename) so it shows up in the
digest / search alongside arXiv papers.
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import socket
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
_MAX_REDIRECTS = 5
_STREAM_CHUNK = 64 * 1024


def _assert_public_host(host: str) -> None:
    """Raise ImportError unless `host` resolves only to globally-routable IPs.

    Rejects loopback, link-local (169.254/16, fe80::/10), private (10/8,
    172.16/12, 192.168/16, fc00::/7), multicast, and reserved ranges. This is
    SSRF defence for the user-supplied custom-import URL: without it, a paste
    of `http://169.254.169.254/...` (cloud metadata) or an internal admin URL
    would be fetched verbatim.

    Residual TOCTOU window: the IP we resolve here may differ from the IP
    httpx connects to a moment later if DNS rebinds. The realistic threat
    here is a user pasting a sketchy URL, not a remote attacker controlling
    DNS for a hostname the user trusts; we accept the small window.
    """
    if not host:
        raise ImportError("URL has no hostname")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ImportError(f"Could not resolve {host}") from exc
    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            raise ImportError(
                f"refusing to fetch internal address {ip} (host {host})"
            )

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


async def _safe_stream_pdf(client: httpx.AsyncClient, url: str) -> Tuple[bytes, str]:
    """Follow redirects manually, validating the destination host at each hop,
    then stream the response body with a hard byte cap.

    Returns ``(body, final_url)``. Raises ``ImportError`` on any policy
    violation (internal IP, oversize, non-PDF, unreachable, redirect loop).
    """
    current = url
    for _ in range(_MAX_REDIRECTS + 1):
        parsed = urlparse(current)
        if parsed.scheme not in ("http", "https"):
            raise ImportError("URL must start with http:// or https://")
        _assert_public_host(parsed.hostname or "")
        try:
            async with client.stream("GET", current) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("location")
                    if not loc:
                        raise ImportError("redirect with no Location")
                    current = str(httpx.URL(current).join(loc))
                    continue
                if resp.status_code >= 400:
                    raise ImportError(
                        f"{parsed.netloc} returned HTTP {resp.status_code}"
                    )
                buf = bytearray()
                async for chunk in resp.aiter_bytes(_STREAM_CHUNK):
                    buf.extend(chunk)
                    if len(buf) > MAX_PDF_BYTES:
                        raise ImportError(
                            f"PDF exceeds {MAX_PDF_BYTES // (1024 * 1024)} MB limit"
                        )
                if not bytes(buf).startswith(PDF_MAGIC):
                    ctype = resp.headers.get("content-type", "?")
                    raise ImportError(
                        f"URL did not serve a PDF (content-type: {ctype})"
                    )
                return bytes(buf), current
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise ImportError(
                f"Could not reach {parsed.netloc} ({type(exc).__name__})"
            ) from exc
    raise ImportError(f"too many redirects (>{_MAX_REDIRECTS})")


async def import_from_url(url: str, timeout_s: float = 60.0) -> Tuple[str, Paper]:
    """Fetch the PDF at `url`, store it, and create a paper row.

    Raises `ImportError` with a user-friendly message on any failure.
    """
    async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=False) as client:
        content, final_url = await _safe_stream_pdf(client, url)

    arxiv_id = _synthetic_id(content)
    _store_pdf(arxiv_id, content)
    paper = _persist_paper(arxiv_id, title=_title_from_url(final_url), origin=f"URL: {url}")
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
