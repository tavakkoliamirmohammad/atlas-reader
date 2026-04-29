import httpx
import pytest
from unittest.mock import AsyncMock, patch

from app import db, imports, papers


SAMPLE_PDF = b"%PDF-1.4\n%fake but valid prefix\n"
NOT_PDF = b"<!doctype html>\n<html>abstract page</html>"


# ---------- id helpers ----------

def test_is_custom_id_matches_prefix():
    assert imports.is_custom_id("custom-abc123")
    assert not imports.is_custom_id("2401.12345")
    assert not imports.is_custom_id("cs.PL/0506012")


def test_synthetic_id_is_deterministic():
    # Same content ⇒ same id, so re-imports dedupe.
    assert imports._synthetic_id(SAMPLE_PDF) == imports._synthetic_id(SAMPLE_PDF)


def test_synthetic_id_differs_for_different_content():
    assert imports._synthetic_id(b"%PDF-1.4\nA") != imports._synthetic_id(b"%PDF-1.4\nB")


# ---------- import_from_upload ----------

def test_import_from_upload_round_trip(atlas_data_dir):
    db.init()
    arxiv_id, paper = imports.import_from_upload("my paper.pdf", SAMPLE_PDF)

    assert arxiv_id.startswith("custom-")
    assert paper.arxiv_id == arxiv_id
    assert paper.title == "my paper"                       # underscore/space/.pdf stripped
    assert paper.authors.startswith("Upload: ")
    assert paper.categories == "custom"

    # Row is in the DB with pdf_path set, file exists on disk.
    row = papers.get(arxiv_id)
    assert row is not None
    assert row["pdf_path"] and row["pdf_path"].endswith(f"{arxiv_id}.pdf")
    from pathlib import Path as _P
    assert _P(row["pdf_path"]).read_bytes() == SAMPLE_PDF


def test_import_from_upload_rejects_non_pdf(atlas_data_dir):
    db.init()
    with pytest.raises(imports.ImportError, match="not a PDF"):
        imports.import_from_upload("a.html", NOT_PDF)


def test_import_from_upload_rejects_oversized(atlas_data_dir, monkeypatch):
    db.init()
    monkeypatch.setattr(imports, "MAX_PDF_BYTES", len(SAMPLE_PDF) - 1)
    with pytest.raises(imports.ImportError, match="exceeds"):
        imports.import_from_upload("big.pdf", SAMPLE_PDF)


def test_import_from_upload_is_idempotent(atlas_data_dir):
    """Same content imported twice produces the same id and doesn't duplicate the row."""
    db.init()
    id1, _ = imports.import_from_upload("one.pdf", SAMPLE_PDF)
    id2, _ = imports.import_from_upload("two.pdf", SAMPLE_PDF)
    assert id1 == id2


# ---------- import_from_url ----------
#
# These tests bypass DNS by stubbing _assert_public_host, then stub the
# streaming httpx client. The new code path uses client.stream(...) (with
# manual redirect following + per-hop SSRF host check) rather than
# client.get(...), so the fakes mirror that contract.

class _FakeStreamResponse:
    def __init__(self, status_code=200, content=SAMPLE_PDF, headers=None):
        self.status_code = status_code
        self._content = content
        self.headers = headers or {"content-type": "application/pdf"}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    async def aiter_bytes(self, chunk_size=64 * 1024):
        # Single chunk is fine for tests; the production cap-checking loop
        # tolerates arbitrary chunking.
        if self._content:
            yield self._content


class _FakeAsyncClient:
    """Returns a queue of stream responses in order, or raises if configured."""

    def __init__(self, responses=None, raise_exc=None):
        self._queue = list(responses or [])
        self._raise = raise_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    def stream(self, method, url):
        if self._raise:
            raise self._raise
        if not self._queue:
            raise AssertionError(f"unexpected extra request to {url}")
        return self._queue.pop(0)


def _patch_client_and_dns(responses=None, raise_exc=None):
    """Patch httpx.AsyncClient + bypass real DNS for the test host."""
    client = _FakeAsyncClient(responses=responses, raise_exc=raise_exc)
    return (
        patch("app.imports.httpx.AsyncClient", lambda *a, **kw: client),
        patch("app.imports._assert_public_host", lambda host: None),
    )


@pytest.mark.asyncio
async def test_import_from_url_happy_path(atlas_data_dir):
    db.init()
    p1, p2 = _patch_client_and_dns(responses=[_FakeStreamResponse()])
    with p1, p2:
        arxiv_id, paper = await imports.import_from_url(
            "https://example.com/a/b/awesome_paper.pdf"
        )
    assert arxiv_id.startswith("custom-")
    assert paper.title == "awesome paper"
    assert "URL: https://example.com/" in paper.authors


@pytest.mark.asyncio
async def test_import_from_url_rejects_non_http(atlas_data_dir):
    db.init()
    with pytest.raises(imports.ImportError, match="http"):
        await imports.import_from_url("ftp://somewhere/x.pdf")


@pytest.mark.asyncio
async def test_import_from_url_rejects_non_pdf_response(atlas_data_dir):
    db.init()
    resp = _FakeStreamResponse(content=NOT_PDF, headers={"content-type": "text/html"})
    p1, p2 = _patch_client_and_dns(responses=[resp])
    with p1, p2:
        with pytest.raises(imports.ImportError, match="did not serve a PDF"):
            await imports.import_from_url("https://example.com/paper")


@pytest.mark.asyncio
async def test_import_from_url_propagates_http_error(atlas_data_dir):
    db.init()
    resp = _FakeStreamResponse(status_code=403, content=b"")
    p1, p2 = _patch_client_and_dns(responses=[resp])
    with p1, p2:
        with pytest.raises(imports.ImportError, match="HTTP 403"):
            await imports.import_from_url("https://example.com/x.pdf")


@pytest.mark.asyncio
async def test_import_from_url_handles_timeout(atlas_data_dir):
    db.init()
    p1, p2 = _patch_client_and_dns(raise_exc=httpx.ConnectTimeout("slow"))
    with p1, p2:
        with pytest.raises(imports.ImportError, match="Could not reach"):
            await imports.import_from_url("https://slowhost.example.com/a.pdf")


# ---------- SSRF defense ----------

@pytest.mark.asyncio
async def test_import_from_url_rejects_loopback(atlas_data_dir):
    """A URL whose host resolves to 127.0.0.1 must be refused before any
    request goes out — `http://localhost/...` is the textbook SSRF pivot."""
    db.init()
    with pytest.raises(imports.ImportError, match="internal address"):
        await imports.import_from_url("http://localhost/paper.pdf")


@pytest.mark.asyncio
async def test_import_from_url_rejects_link_local(atlas_data_dir, monkeypatch):
    """169.254.169.254 is the cloud instance-metadata pivot. Block it even if
    the user pastes the literal IP, not just resolvable hostnames."""
    db.init()
    with pytest.raises(imports.ImportError, match="internal address"):
        await imports.import_from_url("http://169.254.169.254/latest/meta-data/")


@pytest.mark.asyncio
async def test_import_from_url_rejects_rfc1918(atlas_data_dir):
    db.init()
    with pytest.raises(imports.ImportError, match="internal address"):
        await imports.import_from_url("http://10.0.0.42/internal-admin")


@pytest.mark.asyncio
async def test_import_from_url_caps_oversize_stream(atlas_data_dir, monkeypatch):
    """Body cap must trip mid-stream — not after fully buffering — so a
    malicious server can't OOM us with an arbitrarily large response."""
    db.init()
    monkeypatch.setattr(imports, "MAX_PDF_BYTES", 8)
    huge = SAMPLE_PDF + b"X" * 100
    p1, p2 = _patch_client_and_dns(responses=[_FakeStreamResponse(content=huge)])
    with p1, p2:
        with pytest.raises(imports.ImportError, match="exceeds"):
            await imports.import_from_url("https://example.com/x.pdf")


@pytest.mark.asyncio
async def test_import_from_url_redirect_to_internal_is_blocked(atlas_data_dir):
    """A 302 to an internal address must be re-checked at the redirect hop —
    not blindly followed because the original host was public."""
    db.init()
    redirect = _FakeStreamResponse(
        status_code=302,
        content=b"",
        headers={"location": "http://169.254.169.254/secret"},
    )
    client = _FakeAsyncClient(responses=[redirect])
    real_check = imports._assert_public_host
    calls: list[str] = []

    def fake_check(host: str) -> None:
        calls.append(host)
        # First hop (example.com) passes; second hop is the real check.
        if host == "example.com":
            return
        real_check(host)

    with patch("app.imports.httpx.AsyncClient", lambda *a, **kw: client), \
         patch("app.imports._assert_public_host", fake_check):
        with pytest.raises(imports.ImportError, match="internal address"):
            await imports.import_from_url("https://example.com/paper")
    assert calls == ["example.com", "169.254.169.254"]
