"""Atlas FastAPI app — wires HTTP routes to the modules in this package."""

from __future__ import annotations

import asyncio
import dataclasses
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import (
    arxiv,
    asker,
    conversations,
    db,
    digest,
    health,
    papers,
    pdf_cache,
    stats,
    summarizer,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    yield


app = FastAPI(title="Atlas", lifespan=lifespan)


@app.get("/api/health")
async def get_health() -> dict:
    return {
        "ai": health.claude_available(),
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
async def get_digest(build: bool = False) -> dict:
    if build:
        await digest.build_today()
    rows = papers.list_recent(days=3)
    return {"count": len(rows), "papers": [_row_to_dict(r) for r in rows]}


async def _ensure_paper_imported(arxiv_id: str) -> bool:
    """If the paper isn't in the DB, fetch it from arXiv and insert. Return True if known."""
    if papers.get(arxiv_id) is not None:
        return True
    paper = await arxiv.fetch_by_id(arxiv_id)
    if paper is None:
        return False
    papers.upsert([paper])
    return True


@app.get("/api/papers/{arxiv_id}")
async def get_paper(arxiv_id: str) -> dict:
    """Return paper metadata. Auto-imports from arXiv if not already in DB."""
    if not await _ensure_paper_imported(arxiv_id):
        raise HTTPException(status_code=404, detail="paper not found on arXiv")
    row = papers.get(arxiv_id)
    assert row is not None
    stats.record_open(arxiv_id)
    return _row_to_dict(row)


@app.get("/api/pdf/{arxiv_id}")
async def get_pdf(arxiv_id: str):
    """Stream the PDF directly from arXiv on every request (no persistent disk cache)."""
    if not await _ensure_paper_imported(arxiv_id):
        raise HTTPException(status_code=404, detail="paper not found on arXiv")

    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"

    async def _stream():
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            async with client.stream("GET", pdf_url) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    yield chunk

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


def _sse_format(chunk: str) -> bytes:
    return f"data: {chunk}\n\n".encode("utf-8")


_ALLOWED_MODELS = {"opus", "sonnet", "haiku"}


def _normalize_model(value: str | None, default: str) -> str:
    if value and value in _ALLOWED_MODELS:
        return value
    return default


@app.post("/api/summarize/{arxiv_id}")
async def post_summarize(arxiv_id: str, model: str | None = None):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")

    chosen = _normalize_model(model, "opus")

    async def gen():
        try:
            async for chunk in summarizer.summarize(arxiv_id, model=chosen):
                yield _sse_format(chunk)
            yield b"event: done\ndata: ok\n\n"
        except Exception as exc:
            yield f"event: error\ndata: {exc}\n\n".encode("utf-8")

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/ask/{arxiv_id}")
async def post_ask(arxiv_id: str, body: AskBody, model: str | None = None):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")

    # Prefer query param for consistency, fall back to body.
    chosen = _normalize_model(model if model is not None else body.model, "sonnet")

    async def gen():
        try:
            async for chunk in asker.ask(arxiv_id, body.question, body.history, model=chosen):
                yield _sse_format(chunk)
            yield b"event: done\ndata: ok\n\n"
        except Exception as exc:
            yield f"event: error\ndata: {exc}\n\n".encode("utf-8")

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
