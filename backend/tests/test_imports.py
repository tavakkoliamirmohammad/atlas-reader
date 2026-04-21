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

class _FakeResponse:
    def __init__(self, status_code=200, content=SAMPLE_PDF, headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {"content-type": "application/pdf"}


class _FakeAsyncClient:
    def __init__(self, response=None, raise_exc=None):
        self._response = response
        self._raise = raise_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    async def get(self, url):
        if self._raise:
            raise self._raise
        return self._response


@pytest.mark.asyncio
async def test_import_from_url_happy_path(atlas_data_dir):
    db.init()
    resp = _FakeResponse()
    with patch(
        "app.imports.httpx.AsyncClient",
        lambda *a, **kw: _FakeAsyncClient(response=resp),
    ):
        arxiv_id, paper = await imports.import_from_url("https://example.com/a/b/awesome_paper.pdf")

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
    resp = _FakeResponse(content=NOT_PDF, headers={"content-type": "text/html"})
    with patch(
        "app.imports.httpx.AsyncClient",
        lambda *a, **kw: _FakeAsyncClient(response=resp),
    ):
        with pytest.raises(imports.ImportError, match="did not serve a PDF"):
            await imports.import_from_url("https://example.com/paper")


@pytest.mark.asyncio
async def test_import_from_url_propagates_http_error(atlas_data_dir):
    db.init()
    resp = _FakeResponse(status_code=403, content=b"")
    with patch(
        "app.imports.httpx.AsyncClient",
        lambda *a, **kw: _FakeAsyncClient(response=resp),
    ):
        with pytest.raises(imports.ImportError, match="HTTP 403"):
            await imports.import_from_url("https://example.com/x.pdf")


@pytest.mark.asyncio
async def test_import_from_url_handles_timeout(atlas_data_dir):
    db.init()
    with patch(
        "app.imports.httpx.AsyncClient",
        lambda *a, **kw: _FakeAsyncClient(raise_exc=httpx.ConnectTimeout("slow")),
    ):
        with pytest.raises(imports.ImportError, match="Could not reach"):
            await imports.import_from_url("https://slowhost.example.com/a.pdf")
