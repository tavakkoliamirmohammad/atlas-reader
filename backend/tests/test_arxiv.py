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
