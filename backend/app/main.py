"""Atlas FastAPI app — wires HTTP routes to the modules in this package."""

from __future__ import annotations

import dataclasses
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import db, digest, health, papers, pdf_cache


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
    return _row_to_dict(row)


@app.get("/api/pdf/{arxiv_id}")
async def get_pdf(arxiv_id: str):
    """Serve the cached PDF for a paper, downloading from arXiv on first request."""
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")
    path = await pdf_cache.ensure_cached(arxiv_id)
    return FileResponse(path, media_type="application/pdf", filename=f"{arxiv_id}.pdf")


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
