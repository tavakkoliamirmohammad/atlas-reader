import pytest
from unittest.mock import AsyncMock, patch

from app import db, pdf_cache, papers
from app.arxiv import Paper


SAMPLE = Paper(
    arxiv_id="2404.12345",
    title="t", authors="a", abstract="x", categories="cs.PL",
    published="2026-04-18T08:00:00Z",
)


def test_cache_path_returns_data_dir_pdf_path(atlas_data_dir):
    p = pdf_cache.cache_path("2404.12345")
    assert p == atlas_data_dir / "pdfs" / "2404.12345.pdf"


@pytest.mark.asyncio
async def test_ensure_cached_downloads_when_missing(atlas_data_dir, fixtures_dir):
    db.init()
    papers.upsert([SAMPLE])
    pdf_bytes = (fixtures_dir / "tiny.pdf").read_bytes()

    fake_resp = AsyncMock()
    fake_resp.content = pdf_bytes
    fake_resp.raise_for_status = lambda: None

    with patch("app.pdf_cache.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.get = AsyncMock(return_value=fake_resp)

        path = await pdf_cache.ensure_cached("2404.12345")

    assert path.exists()
    assert path.read_bytes() == pdf_bytes
    assert papers.get("2404.12345")["pdf_path"] == str(path)
    instance.get.assert_called_once_with("https://arxiv.org/pdf/2404.12345")


@pytest.mark.asyncio
async def test_ensure_cached_skips_download_when_present(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    target = pdf_cache.cache_path("2404.12345")
    target.write_bytes(b"%PDF-1.4 already-here")

    with patch("app.pdf_cache.httpx.AsyncClient") as MockClient:
        path = await pdf_cache.ensure_cached("2404.12345")
        MockClient.assert_not_called()

    assert path.read_bytes() == b"%PDF-1.4 already-here"


@pytest.mark.asyncio
async def test_ensure_cached_rejects_non_pdf_content(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    fake_resp = AsyncMock()
    fake_resp.content = b"<html><body>rate limited</body></html>"
    fake_resp.raise_for_status = lambda: None

    with patch("app.pdf_cache.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.get = AsyncMock(return_value=fake_resp)

        with pytest.raises(ValueError, match="non-PDF"):
            await pdf_cache.ensure_cached("2404.12345")

    # Cache should not have been polluted with the HTML
    assert not pdf_cache.cache_path("2404.12345").exists()
