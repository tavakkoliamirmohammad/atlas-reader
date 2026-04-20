"""Atlas FastAPI app — wires HTTP routes to the modules in this package."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import db, health, papers


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
