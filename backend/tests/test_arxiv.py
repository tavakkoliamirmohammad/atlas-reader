import pytest
from unittest.mock import AsyncMock, patch

from app import arxiv


def test_parse_returns_paper_dataclasses(fixtures_dir):
    xml_text = (fixtures_dir / "arxiv_sample.xml").read_text()
    papers = arxiv.parse_feed(xml_text)
    assert len(papers) == 2

    p = papers[0]
    assert p.arxiv_id == "2404.12345"  # version stripped
    assert p.title == "SPIRV-LLVM-Bridge: Unified Codegen for GPU Kernels"
    assert p.authors == "Lin Chen, Soyoung Park, Wei Liu"
    assert p.abstract.startswith("Modern accelerator stacks fragment")
    assert p.categories == "cs.PL, cs.AR"
    assert p.published == "2026-04-18T08:00:00Z"

    p2 = papers[1]
    assert p2.arxiv_id == "2404.99999"
    assert p2.authors == "Priya Singh"
    assert p2.categories == "cs.PL"


def test_parse_collapses_whitespace_in_title_and_abstract(fixtures_dir):
    xml_text = (fixtures_dir / "arxiv_sample.xml").read_text()
    papers = arxiv.parse_feed(xml_text)
    assert "\n" not in papers[0].title
    assert "\n" not in papers[0].abstract


def test_parse_empty_feed_returns_empty_list():
    xml_text = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"/>'
    assert arxiv.parse_feed(xml_text) == []


@pytest.mark.asyncio
async def test_fetch_recent_calls_arxiv_api(fixtures_dir):
    xml_text = (fixtures_dir / "arxiv_sample.xml").read_text()
    fake_response = AsyncMock()
    fake_response.text = xml_text
    fake_response.raise_for_status = lambda: None

    with patch("app.arxiv.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.get = AsyncMock(return_value=fake_response)

        papers = await arxiv.fetch_recent(query="cat:cs.PL", max_results=10)

    assert len(papers) == 2
    args, kwargs = instance.get.call_args
    assert args[0] == "https://export.arxiv.org/api/query"
    assert kwargs["params"]["search_query"] == "cat:cs.PL"
    assert kwargs["params"]["max_results"] == "10"
    assert kwargs["params"]["sortBy"] == "submittedDate"
    assert kwargs["params"]["sortOrder"] == "descending"
