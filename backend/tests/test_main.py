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
    with patch("app.main.arxiv.fetch_by_id", new=AsyncMock(return_value=None)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/papers/missing")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_pdf_streams_from_arxiv(atlas_data_dir, fixtures_dir):
    db.init()
    papers.upsert([Paper("44", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    pdf_bytes = (fixtures_dir / "tiny.pdf").read_bytes()

    from contextlib import asynccontextmanager

    class _FakeResp:
        def raise_for_status(self):
            pass

        async def aiter_bytes(self, chunk_size=64 * 1024):
            yield pdf_bytes

    @asynccontextmanager
    async def _fake_stream(self, method, url):
        yield _FakeResp()

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        stream = _fake_stream

    with patch("app.main.httpx.AsyncClient", _FakeClient):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/pdf/44")

    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content == pdf_bytes


@pytest.mark.asyncio
async def test_get_pdf_returns_404_when_paper_missing(atlas_data_dir):
    db.init()
    with patch("app.main.arxiv.fetch_by_id", new=AsyncMock(return_value=None)):
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
    with patch("app.main.arxiv.fetch_by_id", new=AsyncMock(return_value=None)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await c.get("/api/papers/does-not-exist")
            r = await c.get("/api/stats")
    assert r.json()["papers_today"] == 0


@pytest.mark.asyncio
async def test_summarize_streams_sse_events(atlas_data_dir):
    db.init()
    papers.upsert([Paper("55", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])

    async def _fake(arxiv_id, model="opus"):
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

    async def _fake(arxiv_id, question, history, model="sonnet", **_kw):
        captured["arxiv_id"] = arxiv_id
        captured["question"] = question
        captured["history"] = history
        captured["model"] = model
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
    assert captured["model"] == "sonnet"


@pytest.mark.asyncio
async def test_summarize_query_model_overrides_default(atlas_data_dir):
    db.init()
    papers.upsert([Paper("88", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    captured = {}

    async def _fake(arxiv_id, model="opus", **_kw):
        captured["model"] = model
        yield "ok"

    with patch("app.main.summarizer.summarize", _fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await c.post("/api/summarize/88?model=haiku")

    assert captured["model"] == "haiku"


@pytest.mark.asyncio
async def test_ask_query_model_overrides_body(atlas_data_dir):
    db.init()
    papers.upsert([Paper("89", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    captured = {}

    async def _fake(arxiv_id, question, history, model="sonnet", **_kw):
        captured["model"] = model
        yield "ok"

    with patch("app.main.asker.ask", _fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await c.post(
                "/api/ask/89?model=opus",
                json={"question": "Q", "history": [], "model": "haiku"},
            )

    # Query param wins over body
    assert captured["model"] == "opus"


@pytest.mark.asyncio
async def test_ask_body_model_used_when_no_query(atlas_data_dir):
    db.init()
    papers.upsert([Paper("90", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    captured = {}

    async def _fake(arxiv_id, question, history, model="sonnet", **_kw):
        captured["model"] = model
        yield "ok"

    with patch("app.main.asker.ask", _fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await c.post(
                "/api/ask/90",
                json={"question": "Q", "history": [], "model": "haiku"},
            )

    assert captured["model"] == "haiku"


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


@pytest.mark.asyncio
async def test_conversations_endpoint_filters_by_thread(atlas_data_dir):
    db.init()
    papers.upsert([Paper("78", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    conv_mod.append("78", "user", "in default")
    conv_mod.append("78", "user", "in thread 2", thread_id=2)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r1 = await c.get("/api/conversations/78")
        r2 = await c.get("/api/conversations/78?thread_id=2")

    assert [m["content"] for m in r1.json()["messages"]] == ["in default"]
    assert [m["content"] for m in r2.json()["messages"]] == ["in thread 2"]


@pytest.mark.asyncio
async def test_threads_list_includes_default(atlas_data_dir):
    db.init()
    papers.upsert([Paper("80", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/threads/80")

    assert r.status_code == 200
    threads = r.json()["threads"]
    assert any(t["id"] == 1 for t in threads)


@pytest.mark.asyncio
async def test_create_thread_endpoint_returns_id_and_lists(atlas_data_dir):
    db.init()
    papers.upsert([Paper("81", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        cr = await c.post("/api/threads/81", json={"title": "Followups"})
        assert cr.status_code == 200
        new_id = cr.json()["id"]

        lr = await c.get("/api/threads/81")

    titles = [t["title"] for t in lr.json()["threads"]]
    ids = [t["id"] for t in lr.json()["threads"]]
    assert "Followups" in titles
    assert new_id in ids


@pytest.mark.asyncio
async def test_create_thread_endpoint_404_for_unknown_paper(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/threads/missing", json={"title": "x"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_ask_accepts_thread_id_query_param(atlas_data_dir):
    """/api/ask is ephemeral, but the thread_id query param must still be accepted."""
    db.init()
    papers.upsert([Paper("82", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])

    async def _fake(arxiv_id, question, history, model="sonnet", **_kw):
        yield "ok"

    with patch("app.main.asker.ask", _fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post(
                "/api/ask/82?thread_id=7",
                json={"question": "Q", "history": []},
            )

    assert r.status_code == 200
    assert "data: ok" in r.text


@pytest.mark.asyncio
async def test_build_progress_emits_sse_events_from_builds_log(atlas_data_dir):
    db.init()
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO builds (date, status, log) VALUES (?, ?, ?)",
            ("2026-04-19", "done",
             "Fetching arXiv...\nRanking with Sonnet...\nSummarizing 5/30...\ndone"),
        )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with c.stream("GET", "/api/build-progress?date=2026-04-19") as r:
            body = b""
            async for chunk in r.aiter_bytes():
                body += chunk
    text = body.decode()
    assert "Fetching arXiv..." in text
    assert "Ranking with Sonnet..." in text
    assert "Summarizing 5/30..." in text
    assert "event: done" in text


@pytest.mark.asyncio
async def test_build_progress_returns_404_when_no_build_for_date(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/build-progress?date=2099-01-01")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_glossary_get_returns_empty_initially(atlas_data_dir):
    db.init()
    papers.upsert([Paper("g100", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/glossary/g100")
    assert r.status_code == 200
    assert r.json() == {"terms": []}


@pytest.mark.asyncio
async def test_glossary_extract_endpoint_returns_term_list(atlas_data_dir):
    db.init()
    papers.upsert([Paper("g101", "T", "A", "abstract here", "cs.PL", "2026-04-19T08:00:00Z")])

    async def _fake_extract(arxiv_id):
        # Mimic glossary.extract_terms: persist + return term list.
        from app import glossary as g
        with db.connect() as conn:
            conn.executemany(
                "INSERT OR IGNORE INTO glossary (arxiv_id, term) VALUES (?, ?)",
                [(arxiv_id, t) for t in ["MLIR", "DSL"]],
            )
        return ["MLIR", "DSL"]

    with patch("app.main.glossary.extract_terms", _fake_extract):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/api/glossary/g101/extract")

    assert r.status_code == 200
    body = r.json()
    assert body["extracted"] == ["MLIR", "DSL"]
    assert [t["term"] for t in body["terms"]] == ["MLIR", "DSL"]


@pytest.mark.asyncio
async def test_glossary_extract_404_for_unknown_paper(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/glossary/missing/extract")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_glossary_definition_endpoint_returns_text(atlas_data_dir):
    db.init()
    papers.upsert([Paper("g102", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])

    async def _fake_define(arxiv_id, term):
        return f"definition of {term}"

    with patch("app.main.glossary.define", _fake_define):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/glossary/g102/MLIR/definition")

    assert r.status_code == 200
    assert r.json() == {"term": "MLIR", "definition": "definition of MLIR"}


@pytest.mark.asyncio
async def test_glossary_definition_404_for_unknown_paper(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/glossary/missing/MLIR/definition")
    assert r.status_code == 404
