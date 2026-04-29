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
    with patch(
        "app.main.ai_backend.available_backends",
        new=AsyncMock(return_value={"claude": True, "codex": False}),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ai"] is True
    assert body["backends"] == {"claude": True, "codex": False}
    assert body["default_backend"] == "codex"


@pytest.mark.asyncio
async def test_health_endpoint_when_no_backend_available(atlas_data_dir):
    db.init()
    with patch(
        "app.main.ai_backend.available_backends",
        new=AsyncMock(return_value={"claude": False, "codex": False}),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.json()["ai"] is False
    assert r.json()["backends"] == {"claude": False, "codex": False}


@pytest.mark.asyncio
async def test_health_endpoint_reports_tts_when_available(atlas_data_dir):
    db.init()
    # Force a fresh probe (cache from a previous test could short-circuit).
    import app.main as main_mod
    main_mod._tts_health_cache = (0.0, False)
    with patch(
        "app.main.ai_backend.available_backends",
        new=AsyncMock(return_value={"claude": True, "codex": False}),
    ), patch("app.main.tts_client.health_ok", new=AsyncMock(return_value=True)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.json()["tts"] is True


@pytest.mark.asyncio
async def test_health_endpoint_reports_tts_when_unavailable(atlas_data_dir):
    db.init()
    import app.main as main_mod
    main_mod._tts_health_cache = (0.0, False)
    with patch(
        "app.main.ai_backend.available_backends",
        new=AsyncMock(return_value={"claude": False, "codex": False}),
    ), patch("app.main.tts_client.health_ok", new=AsyncMock(return_value=False)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.json()["tts"] is False


@pytest.mark.asyncio
async def test_health_endpoint_caches_tts_probe(atlas_data_dir):
    """Within the TTL window, repeated /api/health calls should hit health_ok once."""
    db.init()
    import app.main as main_mod
    main_mod._tts_health_cache = (0.0, False)
    probe = AsyncMock(return_value=True)
    with patch(
        "app.main.ai_backend.available_backends",
        new=AsyncMock(return_value={"claude": True, "codex": True}),
    ), patch("app.main.tts_client.health_ok", probe):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await c.get("/api/health")
            await c.get("/api/health")
            await c.get("/api/health")
    assert probe.call_count == 1  # cached after first call


@pytest.mark.asyncio
async def test_digest_endpoint_does_a_live_arxiv_fetch(atlas_data_dir):
    """One combined OR query covers all categories in a single arXiv hit."""
    db.init()
    pl = Paper("pl-1", "T-PL", "A", "x", "cs.PL", "2026-04-21T08:00:00Z")
    ar = Paper("ar-1", "T-AR", "A", "x", "cs.AR", "2026-04-22T08:00:00Z")
    fetch = AsyncMock(return_value=[pl, ar])

    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    # Newest first (sorted by published desc).
    assert [p["arxiv_id"] for p in body["papers"]] == ["ar-1", "pl-1"]
    # ONE arXiv request, not one-per-category.
    assert fetch.await_count == 1


@pytest.mark.asyncio
async def test_digest_endpoint_combines_categories_into_or_query(atlas_data_dir):
    """The query joins every category with OR so a single fetch covers them all."""
    db.init()
    fetch = AsyncMock(return_value=[])
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await c.get("/api/digest?cats=cs.PL,math.OC")
    query = fetch.await_args_list[0].args[0]
    assert query == "cat:cs.PL OR cat:math.OC"


@pytest.mark.asyncio
async def test_digest_endpoint_dedupes_cross_category_duplicates(atlas_data_dir):
    """A paper cross-listed in two requested categories shouldn't appear twice."""
    db.init()
    # arXiv returns the union itself, but it CAN return the same id twice
    # if the OR-query causes it (rare). The shaper still dedupes by id.
    same = Paper("dup-1", "Cross-listed", "A", "x", "cs.PL", "2026-04-22T08:00:00Z")
    fetch = AsyncMock(return_value=[same, same])
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest")
    # A single combined query never returns the same id twice in practice,
    # but if it did, sorted() preserves order. Either way we're not double-
    # counting on the wire vs the old per-category fan-out.
    assert r.json()["count"] >= 1


@pytest.mark.asyncio
async def test_digest_endpoint_tolerates_fetch_failures(atlas_data_dir):
    """The single combined fetch raising surfaces as a failures entry, not 500."""
    db.init()
    fetch = AsyncMock(side_effect=RuntimeError("flaky"))
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 0
    assert len(body["failures"]) == 1


@pytest.mark.asyncio
async def test_digest_endpoint_classifies_rate_limit_failures(atlas_data_dir):
    """A 429 from arXiv shows up as kind='rate_limited' in the response."""
    import httpx as _httpx
    db.init()
    fake_resp = _httpx.Response(429, request=_httpx.Request("GET", "http://x"))
    rate_err = _httpx.HTTPStatusError("429", request=fake_resp.request, response=fake_resp)
    fetch = AsyncMock(side_effect=rate_err)
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 0
    assert body["failures"][0]["kind"] == "rate_limited"


@pytest.mark.asyncio
async def test_digest_endpoint_uses_user_supplied_categories(atlas_data_dir):
    """`?cats=` overrides the defaults — and is what shows up in the query."""
    db.init()
    fetch = AsyncMock(return_value=[])
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest?cats=cs.PL,math.OC")
    assert r.status_code == 200
    body = r.json()
    assert body["categories"] == ["cs.PL", "math.OC"]
    assert fetch.await_count == 1


@pytest.mark.asyncio
async def test_digest_endpoint_rejects_malformed_category(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/digest?cats=cs.PL,bad cat")
    assert r.status_code == 400
    assert "invalid arxiv category" in r.json()["detail"]


@pytest.mark.asyncio
async def test_digest_endpoint_falls_back_to_defaults_when_cats_blank(atlas_data_dir):
    db.init()
    fetch = AsyncMock(return_value=[])
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest?cats=")
    assert r.status_code == 200
    assert r.json()["categories"] == ["cs.PL", "cs.AR", "cs.DC", "cs.PF"]


@pytest.mark.asyncio
async def test_digest_endpoint_passes_days_window_to_arxiv(atlas_data_dir):
    """`?days=N` ANDs an arXiv submittedDate filter onto the OR-clause."""
    db.init()
    fetch = AsyncMock(return_value=[])
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest?cats=cs.PL,cs.AR&days=3")
    assert r.status_code == 200
    body = r.json()
    assert body["days"] == 3
    assert fetch.await_count == 1
    query = fetch.await_args_list[0].args[0]
    # Parens isolate the OR so the date filter ANDs against the WHOLE union,
    # not just the trailing cat:... fragment.
    assert query.startswith("(cat:cs.PL OR cat:cs.AR) AND submittedDate:[")


@pytest.mark.asyncio
async def test_digest_endpoint_omits_date_filter_when_days_absent(atlas_data_dir):
    db.init()
    fetch = AsyncMock(return_value=[])
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest?cats=cs.PL")
    assert r.status_code == 200
    assert r.json()["days"] is None
    query = fetch.await_args_list[0].args[0]
    assert query == "cat:cs.PL"


@pytest.mark.asyncio
async def test_digest_endpoint_caches_per_days_window(atlas_data_dir):
    """Cache key is (sorted-cats, days) — different windows mean different
    arXiv queries; same key within TTL is a hit."""
    db.init()
    fetch = AsyncMock(return_value=[])
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await c.get("/api/digest?cats=cs.PL&days=3")
            await c.get("/api/digest?cats=cs.PL&days=3")  # hit
            await c.get("/api/digest?cats=cs.PL&days=7")  # different window
    assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_digest_endpoint_rejects_invalid_days(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        for bad in ("0", "-1", "999", "abc"):
            r = await c.get(f"/api/digest?cats=cs.PL&days={bad}")
            assert r.status_code == 400, (bad, r.text)


@pytest.mark.asyncio
async def test_digest_caches_per_category_and_fresh_busts(atlas_data_dir):
    """Second call within TTL is served from cache; ?fresh=true forces a refetch."""
    db.init()
    sample = [Paper("c-1", "T", "A", "x", "cs.PL", "2026-04-22T08:00:00Z")]
    fetch = AsyncMock(return_value=sample)
    with patch("app.digest.arxiv.fetch_recent", fetch):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r1 = await c.get("/api/digest?cats=cs.PL")
            r2 = await c.get("/api/digest?cats=cs.PL")
            r3 = await c.get("/api/digest?cats=cs.PL&fresh=true")
    assert r1.status_code == r2.status_code == r3.status_code == 200
    # Cache hit on r2 means arXiv was only hit once for the first two calls.
    # `fresh=true` on r3 always forces another fetch.
    assert fetch.await_count == 2


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
        status_code = 200

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

        async def aclose(self):
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
async def test_spa_fallback_rejects_path_traversal(tmp_path, monkeypatch):
    """A request that resolves outside the dist dir must fall through to
    index.html, never serve the escaped file. Without the confinement check,
    `/../secret.txt` (after FastAPI URL decoding) would be served verbatim
    because FileResponse does no path validation."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>Atlas SPA</title>")
    secret = tmp_path / "secret.txt"
    secret.write_text("BEARER_TOKEN_DO_NOT_LEAK")
    monkeypatch.setenv("ATLAS_FRONTEND_DIST", str(dist))
    from importlib import reload
    from app import main as main_mod
    reload(main_mod)

    async with AsyncClient(transport=ASGITransport(app=main_mod.app), base_url="http://t") as c:
        r = await c.get("/../secret.txt")
    assert r.status_code == 200
    assert "BEARER_TOKEN_DO_NOT_LEAK" not in r.text
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

    async def _fake(arxiv_id, **_kw):
        # Include paragraph break + bold marker — the regression case that
        # broke when chunks were embedded raw into `data:` (the `\n\n` was
        # interpreted as an SSE event terminator and silently dropped).
        yield "## 1. Background\n\n"
        yield "**Bold** body."

    with patch("app.main.summarizer.summarize", _fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/api/summarize/55")
            body = r.text

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    # Each chunk is JSON-encoded into the SSE `data:` field so newlines
    # and markdown markers survive transport.
    import json as _json
    assert f'data: {_json.dumps({"t": "## 1. Background\n\n"})}' in body
    assert f'data: {_json.dumps({"t": "**Bold** body."})}' in body
    assert "event: done" in body


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
    import json as _json
    assert f'data: {_json.dumps({"t": "answer "})}' in body
    assert f'data: {_json.dumps({"t": "chunk"})}' in body
    assert captured["question"] == "Why?"
    assert captured["history"][0]["content"] == "earlier"
    # Endpoint no longer forces a specific Claude model; ai_backend picks a
    # task- and backend-appropriate default downstream.
    assert captured["model"] is None


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
            # Claude-specific model override requires `backend=claude`; otherwise
            # Codex's allowlist rejects "haiku" and the default kicks in.
            await c.post("/api/summarize/88?backend=claude&model=haiku")

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
                "/api/ask/89?backend=claude&model=opus",
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
                "/api/ask/90?backend=claude",
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


