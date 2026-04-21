"""Atlas FastAPI app — wires HTTP routes to the modules in this package."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import (
    ai_argv,
    ai_backend,
    arxiv,
    asker,
    conversations,
    db,
    digest,
    glossary,
    health,
    highlights,
    papers,
    pdf_cache,
    search,
    stats,
    summarizer,
)


async def _daily_build_loop() -> None:
    """Once an hour, ensure today's digest has been built.

    Runs in the background from app startup. Skips if today's build row
    already has status='done', so restarting the backend repeatedly doesn't
    re-hammer arXiv. Always uses rank=False to keep the check cheap — users
    who want AI tiering trigger it explicitly from the UI.
    """
    import logging
    from datetime import date
    log = logging.getLogger("atlas.scheduler")
    while True:
        try:
            today = date.today().isoformat()
            with db.connect() as conn:
                cur = conn.execute("SELECT status FROM builds WHERE date = ?", (today,))
                row = cur.fetchone()
            if row is None or row["status"] != "done":
                log.info("scheduler: building today's digest (status=%s)",
                         None if row is None else row["status"])
                try:
                    await digest.build_today(rank=False)
                    log.info("scheduler: build complete")
                except Exception as e:                # noqa: BLE001
                    log.warning("scheduler: build failed: %s: %s", type(e).__name__, e)
        except asyncio.CancelledError:
            raise
        except Exception:                             # noqa: BLE001
            log.exception("scheduler tick error")
        try:
            await asyncio.sleep(3600)  # 1 hour
        except asyncio.CancelledError:
            return


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    scheduler_task = asyncio.create_task(_daily_build_loop())
    try:
        yield
    finally:
        scheduler_task.cancel()
        try:
            await scheduler_task
        except (asyncio.CancelledError, Exception):   # noqa: BLE001
            pass


app = FastAPI(title="Atlas", lifespan=lifespan)


@app.get("/api/health")
async def get_health() -> dict:
    backends = await ai_backend.available_backends()
    return {
        # Keep the legacy `ai` key so older clients still get a boolean;
        # true if *any* backend is available.
        "ai": backends["claude"] or backends["codex"],
        "backends": backends,
        "default_backend": ai_backend.DEFAULT_BACKEND,
        "papers_today": len(papers.list_recent(days=1)),
    }


def _row_to_dict(row) -> dict:
    """Coerce sqlite3.Row or any dataclass-like row to a plain dict."""
    if hasattr(row, "keys"):
        return {k: row[k] for k in row.keys()}
    if dataclasses.is_dataclass(row):
        return dataclasses.asdict(row)
    raise TypeError(f"Cannot convert {type(row).__name__} to dict")


@app.get("/api/digest")
async def get_digest(
    build: bool = False,
    days: str = "7",
    backend: str | None = None,
    rank: bool = True,
) -> dict:
    if build:
        await digest.build_today(
            backend=ai_backend.normalize_backend(backend),
            rank=rank,
        )
    days_arg: int | None
    if days == "all":
        days_arg = None
    else:
        try:
            n = int(days)
            if n <= 0:
                raise HTTPException(status_code=400, detail="days must be positive or 'all'")
            days_arg = n
        except ValueError:
            raise HTTPException(status_code=400, detail="days must be an integer or 'all'")
    rows = papers.list_recent(days=days_arg)
    return {"count": len(rows), "papers": [_row_to_dict(r) for r in rows]}


class ArxivUnavailable(Exception):
    """arXiv returned a retryable error (throttling, timeout) we couldn't overcome."""


async def _ensure_paper_imported(arxiv_id: str) -> bool:
    """If the paper isn't in the DB, fetch it from arXiv and insert. Return True if known.

    Raises `ArxivUnavailable` on throttle/timeout so the endpoint can turn that
    into a 503 with a clear message, rather than an opaque 500.
    """
    if papers.get(arxiv_id) is not None:
        return True
    try:
        paper = await arxiv.fetch_by_id(arxiv_id)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (429, 503):
            raise ArxivUnavailable("arXiv is throttling this IP; try again in a few minutes") from exc
        raise
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise ArxivUnavailable(f"arXiv unreachable ({type(exc).__name__})") from exc
    if paper is None:
        return False
    papers.upsert([paper])
    return True


@app.get("/api/papers/{arxiv_id}")
async def get_paper(arxiv_id: str) -> dict:
    """Return paper metadata. Auto-imports from arXiv if not already in DB."""
    try:
        imported = await _ensure_paper_imported(arxiv_id)
    except ArxivUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if not imported:
        raise HTTPException(status_code=404, detail="paper not found on arXiv")
    row = papers.get(arxiv_id)
    assert row is not None
    stats.record_open(arxiv_id)
    return _row_to_dict(row)


@app.get("/api/pdf/{arxiv_id}")
async def get_pdf(arxiv_id: str):
    """Stream the PDF directly from arXiv on every request (no persistent disk cache)."""
    try:
        imported = await _ensure_paper_imported(arxiv_id)
    except ArxivUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if not imported:
        raise HTTPException(status_code=404, detail="paper not found on arXiv")

    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"

    # Do a HEAD-like probe: open the stream, check status, then either stream
    # the body or raise a clean HTTPException. Doing the check BEFORE returning
    # StreamingResponse means 429s surface as a 503 with a JSON message instead
    # of a partial-body response the browser can't recover from.
    client = httpx.AsyncClient(timeout=60.0, follow_redirects=True)
    stream_ctx = client.stream("GET", pdf_url)
    try:
        resp = await stream_ctx.__aenter__()
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        await client.aclose()
        raise HTTPException(status_code=503, detail=f"arXiv unreachable ({type(exc).__name__})")

    if resp.status_code in (429, 503):
        await stream_ctx.__aexit__(None, None, None)
        await client.aclose()
        raise HTTPException(status_code=503, detail="arXiv is throttling this IP; try again in a few minutes")
    if resp.status_code >= 400:
        await stream_ctx.__aexit__(None, None, None)
        await client.aclose()
        raise HTTPException(status_code=resp.status_code, detail=f"arXiv responded {resp.status_code}")

    async def _stream():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                yield chunk
        finally:
            await stream_ctx.__aexit__(None, None, None)
            await client.aclose()

    return StreamingResponse(
        _stream(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{arxiv_id}.pdf"'},
    )


@app.get("/api/stats")
async def get_stats() -> dict:
    return stats.summary()


class AskBody(BaseModel):
    question: str
    history: list[dict] = []
    model: str | None = None
    backend: str | None = None


def _sse_format(chunk: str) -> bytes:
    """Serialize a streaming text chunk as a single SSE event.

    SSE protocol uses `\n\n` as the event terminator and treats every `\n`
    inside a `data:` payload as a field separator. Naively interpolating the
    raw chunk therefore corrupts whitespace whenever the model emits paragraph
    breaks (the second paragraph silently becomes a new event with no `data:`
    prefix and gets dropped). JSON-encoding the chunk as a single line keeps
    every byte intact; the frontend reverses this with JSON.parse.
    """
    payload = json.dumps({"t": chunk}, ensure_ascii=False)
    return f"data: {payload}\n\n".encode("utf-8")


def _normalize_model(value: str | None, backend: str) -> str | None:
    """Return the model if it's in the allowlist for the chosen backend;
    otherwise None so ai_backend picks the per-(backend, task) default."""
    if not value:
        return None
    if value in ai_argv.allowed_models(backend):          # type: ignore[arg-type]
        return value
    return None


@app.post("/api/summarize/{arxiv_id}")
async def post_summarize(
    arxiv_id: str,
    model: str | None = None,
    backend: str | None = None,
):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")

    chosen_backend = ai_backend.normalize_backend(backend)
    chosen_model = _normalize_model(model, chosen_backend)

    async def gen():
        try:
            async for chunk in summarizer.summarize(
                arxiv_id, backend=chosen_backend, model=chosen_model,
            ):
                yield _sse_format(chunk)
            yield b"event: done\ndata: ok\n\n"
        except Exception as exc:
            err_payload = json.dumps({"message": str(exc)}, ensure_ascii=False)
            yield f"event: error\ndata: {err_payload}\n\n".encode("utf-8")

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/ask/{arxiv_id}")
async def post_ask(
    arxiv_id: str,
    body: AskBody,
    model: str | None = None,
    backend: str | None = None,
):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")

    # Query param wins, body is fallback.
    chosen_backend = ai_backend.normalize_backend(backend if backend is not None else body.backend)
    chosen_model = _normalize_model(
        model if model is not None else body.model,
        chosen_backend,
    )

    async def gen():
        try:
            async for chunk in asker.ask(
                arxiv_id, body.question, body.history,
                backend=chosen_backend, model=chosen_model,
            ):
                yield _sse_format(chunk)
            yield b"event: done\ndata: ok\n\n"
        except Exception as exc:
            err_payload = json.dumps({"message": str(exc)}, ensure_ascii=False)
            yield f"event: error\ndata: {err_payload}\n\n".encode("utf-8")

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/conversations/{arxiv_id}")
async def get_conversations(arxiv_id: str) -> dict:
    rows = conversations.history(arxiv_id)
    return {"messages": [_row_to_dict(r) for r in rows]}


def _build_row(date_str: str):
    with db.connect() as conn:
        cur = conn.execute("SELECT status, log FROM builds WHERE date = ?", (date_str,))
        return cur.fetchone()


async def _build_progress_events(date_str: str):
    """Emit one SSE event per line of the build's log; emit terminal event at end."""
    emitted = 0
    while True:
        row = _build_row(date_str)
        if row is None:
            return
        lines = (row["log"] or "").splitlines()
        for line in lines[emitted:]:
            yield f"data: {line}\n\n"
        emitted = len(lines)
        if row["status"] in ("done", "failed"):
            yield f"event: {row['status']}\ndata: {row['status']}\n\n"
            return
        await asyncio.sleep(0.25)


@app.get("/api/build-progress")
async def get_build_progress(date: str):
    if _build_row(date) is None:
        raise HTTPException(status_code=404, detail="no build for that date")
    return StreamingResponse(
        _build_progress_events(date),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


class HighlightBody(BaseModel):
    quote: str
    color: str = "yellow"
    page: int | None = None
    note: str | None = None
    rects: list[dict] | None = None


@app.get("/api/highlights/{arxiv_id}")
async def get_highlights(arxiv_id: str) -> dict:
    return {"highlights": highlights.list_for(arxiv_id)}


@app.post("/api/highlights/{arxiv_id}")
async def post_highlight(arxiv_id: str, body: HighlightBody) -> dict:
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")
    quote = body.quote.strip()
    if not quote:
        raise HTTPException(status_code=400, detail="quote must be non-empty")
    new_id = highlights.add(
        arxiv_id,
        quote,
        color=body.color or "yellow",
        page=body.page,
        note=body.note,
        rects=body.rects,
    )
    return {"id": new_id}


@app.delete("/api/highlights/{highlight_id}", status_code=204)
async def delete_highlight(highlight_id: int) -> Response:
    if not highlights.delete(highlight_id):
        raise HTTPException(status_code=404, detail="highlight not found")
    return Response(status_code=204)


@app.get("/api/glossary/{arxiv_id}")
async def get_glossary(arxiv_id: str) -> dict:
    rows = glossary.list_for(arxiv_id)
    return {"terms": [_row_to_dict(r) for r in rows]}


@app.post("/api/glossary/{arxiv_id}/extract")
async def post_glossary_extract(arxiv_id: str) -> dict:
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")
    try:
        terms = await glossary.extract_terms(arxiv_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="paper not found")
    rows = glossary.list_for(arxiv_id)
    return {"extracted": terms, "terms": [_row_to_dict(r) for r in rows]}


@app.get("/api/glossary/{arxiv_id}/{term}/definition")
async def get_glossary_definition(arxiv_id: str, term: str) -> dict:
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")
    try:
        text = await glossary.define(arxiv_id, term)
    except KeyError:
        raise HTTPException(status_code=404, detail="paper not found")
    return {"term": term, "definition": text}


@app.get("/api/search")
async def get_search(q: str = "", limit: int = 20) -> dict:
    """Full-text search across cached papers (title, authors, abstract, categories)."""
    capped = max(1, min(int(limit), 100))
    results = search.search(q, limit=capped)
    return {"count": len(results), "results": results}


def _frontend_dist() -> Path | None:
    raw = os.environ.get("ATLAS_FRONTEND_DIST")
    if raw:
        p = Path(raw)
    else:
        p = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    return p if p.exists() else None


_dist = _frontend_dist()
if _dist is not None:
    if (_dist / "assets").exists():
        app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    async def _index() -> FileResponse:
        return FileResponse(_dist / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = _dist / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
