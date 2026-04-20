"""Atlas FastAPI app — wires HTTP routes to the modules in this package."""

from __future__ import annotations

import asyncio
import dataclasses
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import asker, conversations, db, digest, health, papers, pdf_cache, stats, summarizer


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


@app.get("/api/papers/{arxiv_id}")
async def get_paper(arxiv_id: str) -> dict:
    """Return a single paper's metadata, 404 if not found."""
    row = papers.get(arxiv_id)
    if row is None:
        raise HTTPException(status_code=404, detail="paper not found")
    stats.record_open(arxiv_id)
    return _row_to_dict(row)


@app.get("/api/pdf/{arxiv_id}")
async def get_pdf(arxiv_id: str):
    """Serve the cached PDF for a paper, downloading from arXiv on first request."""
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")
    path = await pdf_cache.ensure_cached(arxiv_id)
    return FileResponse(path, media_type="application/pdf", filename=f"{arxiv_id}.pdf")


@app.get("/api/stats")
async def get_stats() -> dict:
    return stats.summary()


class AskBody(BaseModel):
    question: str
    history: list[dict] = []


def _sse_format(chunk: str) -> bytes:
    return f"data: {chunk}\n\n".encode("utf-8")


@app.post("/api/summarize/{arxiv_id}")
async def post_summarize(arxiv_id: str):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")

    async def gen():
        try:
            async for chunk in summarizer.summarize(arxiv_id):
                yield _sse_format(chunk)
            yield b"event: done\ndata: ok\n\n"
        except Exception as exc:
            yield f"event: error\ndata: {exc}\n\n".encode("utf-8")

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/ask/{arxiv_id}")
async def post_ask(arxiv_id: str, body: AskBody):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")

    async def gen():
        try:
            async for chunk in asker.ask(arxiv_id, body.question, body.history):
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
