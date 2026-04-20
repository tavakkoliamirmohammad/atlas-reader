import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app import db, papers
from app.arxiv import Paper
from app.main import app
from app import asker as asker_mod
from app import summarizer as sum_mod
from app import conversations as conv_mod


@pytest.mark.asyncio
async def test_health_endpoint_returns_ai_status(atlas_data_dir):
    db.init()
    with patch("app.main.health.claude_available", return_value=True):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ai"] is True
    assert "papers_today" in body


@pytest.mark.asyncio
async def test_health_endpoint_when_claude_missing(atlas_data_dir):
    db.init()
    with patch("app.main.health.claude_available", return_value=False):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.json()["ai"] is False


@pytest.mark.asyncio
async def test_digest_endpoint_triggers_build_and_returns_papers(atlas_data_dir):
    db.init()
    sample = [Paper("1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")]
    fake_build = AsyncMock(return_value=[])
    with patch("app.main.digest.build_today", fake_build):
        with patch("app.main.papers.list_recent", return_value=sample):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                r = await c.get("/api/digest?build=true")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["papers"][0]["arxiv_id"] == "1"
    fake_build.assert_awaited_once()


@pytest.mark.asyncio
async def test_digest_without_build_does_not_call_builder(atlas_data_dir):
    db.init()
    fake_build = AsyncMock()
    with patch("app.main.digest.build_today", fake_build):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest")
    fake_build.assert_not_called()
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_get_paper_returns_row_when_found(atlas_data_dir):
    db.init()
    papers.upsert([Paper("99", "Hello", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/papers/99")
    assert r.status_code == 200
    assert r.json()["title"] == "Hello"


@pytest.mark.asyncio
async def test_get_paper_returns_404_when_missing(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/papers/missing")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_pdf_returns_cached_bytes(atlas_data_dir, fixtures_dir):
    db.init()
    papers.upsert([Paper("44", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    pdf_bytes = (fixtures_dir / "tiny.pdf").read_bytes()
    target = atlas_data_dir / "pdfs" / "44.pdf"
    target.write_bytes(pdf_bytes)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/pdf/44")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content == pdf_bytes


@pytest.mark.asyncio
async def test_get_pdf_returns_404_when_paper_missing(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/pdf/nope")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_static_index_served_at_root_when_dist_exists(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>Atlas</title>")
    (dist / "assets").mkdir()
    (dist / "assets" / "main.js").write_text("console.log('hi')")
    monkeypatch.setenv("ATLAS_FRONTEND_DIST", str(dist))

    from importlib import reload
    from app import main as main_mod
    reload(main_mod)

    async with AsyncClient(transport=ASGITransport(app=main_mod.app), base_url="http://t") as c:
        r = await c.get("/")
        assert r.status_code == 200
        assert "Atlas" in r.text

        r2 = await c.get("/assets/main.js")
        assert r2.status_code == 200
        assert "console.log" in r2.text


@pytest.mark.asyncio
async def test_unknown_non_api_path_falls_back_to_index_html(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>Atlas SPA</title>")
    monkeypatch.setenv("ATLAS_FRONTEND_DIST", str(dist))
    from importlib import reload
    from app import main as main_mod
    reload(main_mod)

    async with AsyncClient(transport=ASGITransport(app=main_mod.app), base_url="http://t") as c:
        r = await c.get("/reader/2404.12345")
    assert r.status_code == 200
    assert "Atlas SPA" in r.text


@pytest.mark.asyncio
async def test_stats_endpoint_returns_all_fields(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/stats")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"streak_days", "total_papers", "papers_today"}
    assert body == {"streak_days": 0, "total_papers": 0, "papers_today": 0}


@pytest.mark.asyncio
async def test_get_paper_records_open_event(atlas_data_dir):
    db.init()
    papers.upsert([Paper("ev1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        await c.get("/api/papers/ev1")
        r = await c.get("/api/stats")
    assert r.json()["papers_today"] == 1
    assert r.json()["total_papers"] == 1


@pytest.mark.asyncio
async def test_get_paper_missing_does_not_log_event(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        await c.get("/api/papers/does-not-exist")
        r = await c.get("/api/stats")
    assert r.json()["papers_today"] == 0


@pytest.mark.asyncio
async def test_summarize_streams_sse_events(atlas_data_dir):
    db.init()
    papers.upsert([Paper("55", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])

    async def _fake(arxiv_id):
        yield "## 1. "
        yield "Background\n"

    with patch("app.main.summarizer.summarize", _fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/api/summarize/55")
            body = r.text

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert "data: ## 1. " in body
    assert "data: Background\n" in body


@pytest.mark.asyncio
async def test_summarize_returns_404_for_missing_paper(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/summarize/nope")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_ask_streams_and_accepts_history(atlas_data_dir):
    db.init()
    papers.upsert([Paper("66", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    captured = {}

    async def _fake(arxiv_id, question, history):
        captured["arxiv_id"] = arxiv_id
        captured["question"] = question
        captured["history"] = history
        yield "answer "
        yield "chunk"

    with patch("app.main.asker.ask", _fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post(
                "/api/ask/66",
                json={"question": "Why?", "history": [{"role": "user", "content": "earlier"}]},
            )
            body = r.text

    assert r.status_code == 200
    assert "data: answer " in body
    assert "data: chunk" in body
    assert captured["question"] == "Why?"
    assert captured["history"][0]["content"] == "earlier"


@pytest.mark.asyncio
async def test_conversations_endpoint_returns_history(atlas_data_dir):
    db.init()
    papers.upsert([Paper("77", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    conv_mod.append("77", "user", "Q")
    conv_mod.append("77", "assistant", "A")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/conversations/77")

    assert r.status_code == 200
    msgs = r.json()["messages"]
    assert [(m["role"], m["content"]) for m in msgs] == [
        ("user", "Q"), ("assistant", "A"),
    ]
