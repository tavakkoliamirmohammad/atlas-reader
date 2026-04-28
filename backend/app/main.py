"""Atlas FastAPI app — wires HTTP routes to the modules in this package."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import time as _time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import (
    ai_argv,
    ai_backend,
    arxiv,
    asker,
    cleanup,
    codex_models,
    conversations,
    db,
    glossary,
    health,
    highlights,
    imports,
    papers,
    pdf_cache,
    podcast,
    search,
    stats,
    summarizer,
    tts_client,
)
from fastapi import UploadFile, File, Form


async def _startup_maintenance() -> None:
    """Run cheap maintenance sweeps once at startup.

    Atlas no longer caches arXiv listings, so there's no digest catch-up to
    do here — the next page load will hit arXiv live. We only run the
    always-safe disk hygiene tasks: orphan-PDF prune, opt-in chat retention,
    and the podcast TTL sweep.
    """
    import logging

    log = logging.getLogger("atlas.scheduler")

    try:
        orphans = conversations.prune_orphan_pdfs()
        if orphans:
            log.info("scheduler: pruned %d orphan PDF(s)", orphans)
    except Exception as e:  # noqa: BLE001
        log.warning("scheduler: prune failed: %s: %s", type(e).__name__, e)

    retention_days = os.environ.get("ATLAS_CHAT_RETENTION_DAYS")
    if retention_days:
        try:
            days = int(retention_days)
            if days > 0:
                n = conversations.prune_older_than(days)
                if n:
                    log.info("scheduler: pruned %d old chat messages", n)
        except ValueError:
            log.warning(
                "scheduler: ATLAS_CHAT_RETENTION_DAYS=%r not an int; skipped",
                retention_days,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("scheduler: chat prune failed: %s: %s", type(e).__name__, e)

    try:
        cleanup.sweep(force=True)
    except Exception as e:  # noqa: BLE001
        log.warning("scheduler: podcast cleanup failed: %s: %s", type(e).__name__, e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    maintenance_task = asyncio.create_task(_startup_maintenance())
    try:
        yield
    finally:
        maintenance_task.cancel()
        try:
            await maintenance_task
        except (asyncio.CancelledError, Exception):   # noqa: BLE001
            pass


app = FastAPI(title="Atlas", lifespan=lifespan)

# CORS: allow the hosted UI (Cloudflare Pages / GitHub Pages / custom domain)
# to call this user's localhost backend. Default includes the vite dev server
# so local development keeps working. Override with ATLAS_CORS_ORIGINS
# (comma-separated) once you know your deployed URL, e.g.:
#   ATLAS_CORS_ORIGINS="https://paper-dashboard.pages.dev"
_default_origins = "http://localhost:5173,http://127.0.0.1:5173"
_origins = [
    o.strip()
    for o in os.environ.get("ATLAS_CORS_ORIGINS", _default_origins).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# TTS availability is probed at most once every TTS_HEALTH_TTL_S. The probe
# itself is cheap (one HTTP GET) but every browser tab polls /api/health every
# few seconds, so caching avoids piling up requests against the sidecar.
_TTS_HEALTH_TTL_S = 5.0
_tts_health_cache: tuple[float, bool] = (0.0, False)


async def _tts_available() -> bool:
    global _tts_health_cache
    now = _time.monotonic()
    if now - _tts_health_cache[0] < _TTS_HEALTH_TTL_S:
        return _tts_health_cache[1]
    ok = await tts_client.health_ok()
    _tts_health_cache = (now, ok)
    return ok


@app.get("/api/health")
async def get_health() -> dict:
    backends = await ai_backend.available_backends()
    return {
        # Keep the legacy `ai` key so older clients still get a boolean;
        # true if *any* backend is available.
        "ai": backends["claude"] or backends["codex"],
        "backends": backends,
        "default_backend": ai_backend.DEFAULT_BACKEND,
        "tts": await _tts_available(),
    }


@app.get("/api/models")
async def get_models(backend: str) -> dict:
    """Return the codex model list discovered from `~/.codex/models_cache.json`.

    In Docker mode the host path isn't visible to the container, so we
    proxy through the runner (which lives on the host alongside `~/.codex/`).
    In host mode we read the cache directly. Only `backend=codex` is supported
    — claude uses three stable aliases hardcoded in the frontend.
    """
    if backend != "codex":
        raise HTTPException(status_code=400, detail=f"models discovery not supported for backend {backend!r}")

    if os.environ.get("ATLAS_AI_PROXY"):
        try:
            models = await ai_backend.codex_models_via_runner()
        except httpx.HTTPStatusError as exc:
            # Pass the runner's status through unchanged so the frontend sees
            # the same shape it would in host mode.
            try:
                detail = exc.response.json().get("detail", str(exc))
            except Exception:                              # noqa: BLE001
                detail = str(exc)
            raise HTTPException(status_code=exc.response.status_code, detail=detail)
        except (httpx.RequestError, RuntimeError) as exc:
            raise HTTPException(status_code=502, detail=f"runner unreachable: {exc}")
        return {"models": models}

    try:
        models = codex_models.load()
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="codex models cache not found — run codex once to populate")
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"models": models}


def _row_to_dict(row) -> dict:
    """Coerce sqlite3.Row or any dataclass-like row to a plain dict."""
    if hasattr(row, "keys"):
        return {k: row[k] for k in row.keys()}
    if dataclasses.is_dataclass(row):
        return dataclasses.asdict(row)
    raise TypeError(f"Cannot convert {type(row).__name__} to dict")


# Default categories pulled from arXiv when the client doesn't pass `?cats=`.
# Order here only affects which entry wins on a cross-category duplicate id
# (first wins).
DIGEST_DEFAULT_CATEGORIES = ("cs.PL", "cs.AR", "cs.DC", "cs.PF", "cs.LG")
DIGEST_MAX_PER_CATEGORY = 100
DIGEST_FETCH_TIMEOUT = 30.0
DIGEST_MAX_CATEGORIES = 30

# Per-category in-memory TTL cache. arXiv publishes new submissions on a
# rough daily cadence, so a 2-hour cache stays fresh for typical reading
# sessions while making category toggles, range switches and follow-up
# loads instant. The refresh button bypasses this with `?fresh=true`,
# which is the user's escape hatch when they want to see the latest now.
_DIGEST_CACHE_TTL_S = 2 * 60 * 60
_digest_cache: dict[str, tuple[float, list]] = {}

# arXiv category codes look like `cs.PL`, `math.OC`, `stat.ML`, or bare
# archive prefixes like `physics` / `q-bio`. This regex is permissive
# enough to cover all of them while rejecting anything that could smuggle
# operators or whitespace into the search query.
import re as _re
_ARXIV_CAT = _re.compile(r"^[a-z][a-z\-]*(\.[A-Z]{2})?$")


def _parse_categories(raw: str | None) -> tuple[str, ...]:
    """Validate the user-supplied ?cats=… and fall back to defaults if absent."""
    if raw is None or not raw.strip():
        return DIGEST_DEFAULT_CATEGORIES
    seen: list[str] = []
    for token in raw.split(","):
        c = token.strip()
        if not c:
            continue
        if not _ARXIV_CAT.match(c):
            raise HTTPException(
                status_code=400, detail=f"invalid arxiv category: {c!r}"
            )
        if c not in seen:
            seen.append(c)
    if not seen:
        return DIGEST_DEFAULT_CATEGORIES
    if len(seen) > DIGEST_MAX_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"too many categories (max {DIGEST_MAX_CATEGORIES})",
        )
    return tuple(seen)


def _paper_to_dict(p: arxiv.Paper) -> dict:
    """Match the legacy `papers` row shape so the SPA's Paper type is unchanged."""
    return {
        "arxiv_id": p.arxiv_id,
        "title": p.title,
        "authors": p.authors,
        "abstract": p.abstract,
        "categories": p.categories,
        "published": p.published,
        "pdf_path": None,
        "ai_tier": None,
        "ai_score": None,
        "read_state": "unread",
    }


@app.get("/api/digest")
async def get_digest(cats: str | None = None, fresh: bool = False) -> dict:
    """Live arXiv fetch — every page load is a fresh request.

    `cats` is an optional comma-separated list of arXiv category codes
    (e.g. `cs.PL,cs.AR,math.OC`). When omitted, falls back to a curated
    default set. Each category fires a parallel fetch; partial failures
    are tolerated (whatever came back is returned). The frontend filters
    by date client-side.

    `fresh=true` bypasses the per-category in-memory cache. The user-
    facing refresh button passes this so an explicit "show me the
    newest" doesn't get a stale snapshot.

    Also kicks the throttled cleanup sweep as a fire-and-forget side
    effect: each page load is a natural opportunity to prune stale
    podcast files without making the user wait.
    """
    categories = _parse_categories(cats)
    asyncio.create_task(asyncio.to_thread(cleanup.sweep))

    async def _fetch(cat: str) -> list[arxiv.Paper]:
        # Per-category cache: a category that just came back fresh can
        # serve any future digest request that includes it, regardless of
        # what other categories ride alongside.
        now = _time.monotonic()
        if not fresh:
            entry = _digest_cache.get(cat)
            if entry and (now - entry[0]) < _DIGEST_CACHE_TTL_S:
                return entry[1]
        result = await arxiv.fetch_recent(
            f"cat:{cat}",
            max_results=DIGEST_MAX_PER_CATEGORY,
            timeout=DIGEST_FETCH_TIMEOUT,
        )
        _digest_cache[cat] = (now, result)
        return result

    results = await asyncio.gather(
        *(_fetch(c) for c in categories),
        return_exceptions=True,
    )

    import logging
    log = logging.getLogger("atlas.digest")
    seen: dict[str, arxiv.Paper] = {}
    failures: list[dict] = []
    for cat, res in zip(categories, results):
        if isinstance(res, Exception):
            kind = _classify_fetch_error(res)
            log.warning("digest: fetch failed cat:%s kind=%s err=%s",
                        cat, kind, res)
            failures.append({"category": cat, "kind": kind})
            continue
        for p in res:
            seen.setdefault(p.arxiv_id, p)

    items = sorted(seen.values(), key=lambda p: p.published, reverse=True)
    return {
        "count": len(items),
        "papers": [_paper_to_dict(p) for p in items],
        "categories": list(categories),
        "failures": failures,
    }


def _classify_fetch_error(exc: BaseException) -> str:
    """Classify an arXiv fetch failure into a stable string the SPA can render.

    The backend already retries 429/503 with backoff; if we still see one
    here, the API is genuinely throttling our IP and the right thing for
    the UI is to say so plainly.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        sc = exc.response.status_code
        if sc in (429, 503):
            return "rate_limited"
        return f"http_{sc}"
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return "unreachable"
    return type(exc).__name__


class ArxivUnavailable(Exception):
    """arXiv returned a retryable error (throttling, timeout) we couldn't overcome."""


async def _ensure_paper_imported(arxiv_id: str) -> bool:
    """If the paper isn't in the DB, fetch it from arXiv and insert. Return True if known.

    For `custom-*` ids (URL/upload imports), arXiv is never consulted — we
    only check whether the row already exists.

    Raises `ArxivUnavailable` on throttle/timeout so the endpoint can turn that
    into a 503 with a clear message, rather than an opaque 500.
    """
    if papers.get(arxiv_id) is not None:
        return True
    if imports.is_custom_id(arxiv_id):
        return False
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
    """Serve the PDF. For custom imports, read from disk. For arXiv papers,
    stream directly from arxiv.org on every request (no persistent disk cache).
    """
    try:
        imported = await _ensure_paper_imported(arxiv_id)
    except ArxivUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if not imported:
        raise HTTPException(status_code=404, detail="paper not found")

    # Custom imports (URL/upload) live on disk only.
    if imports.is_custom_id(arxiv_id):
        local = db.data_dir() / "pdfs" / f"{arxiv_id}.pdf"
        if not local.exists():
            raise HTTPException(status_code=404, detail="imported PDF file is missing")
        return FileResponse(
            local,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{arxiv_id}.pdf"'},
        )

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


class ImportUrlBody(BaseModel):
    url: str


@app.post("/api/papers/import-url")
async def post_import_url(body: ImportUrlBody) -> dict:
    """Download a PDF from `url`, store it, return the synthetic paper id."""
    try:
        arxiv_id, _paper = await imports.import_from_url(body.url)
    except imports.ImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"arxiv_id": arxiv_id}


@app.post("/api/papers/import-upload")
async def post_import_upload(file: UploadFile = File(...)) -> dict:
    """Accept a multipart-uploaded PDF, store it, return the synthetic paper id."""
    content = await file.read()
    try:
        arxiv_id, _paper = imports.import_from_upload(
            file.filename or "upload.pdf",
            content,
        )
    except imports.ImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"arxiv_id": arxiv_id}


class AskBody(BaseModel):
    question: str
    history: list[dict] = []
    model: str | None = None
    backend: str | None = None
    # When given, this is what's persisted + rendered as the user's chat
    # bubble instead of `question`. Used by the quick-action chips so the
    # chat log reads "Flow diagram" rather than the 8-line prompt template.
    display: str | None = None


class PodcastBody(BaseModel):
    arxiv_id: str = Field(min_length=1, max_length=128)
    length: str = Field(pattern="^(short|medium|long)$")
    backend: str | None = None
    model: str | None = None


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


def _sse_event(payload: dict) -> bytes:
    """Serialize a structured event dict as a single SSE 'data:' line.

    Used by /api/podcast where each event already has a type discriminator and
    multiple fields (unlike summarize/ask which yield raw text chunks).
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


@app.post("/api/summarize/{arxiv_id}")
async def post_summarize(
    arxiv_id: str,
    model: str | None = None,
    backend: str | None = None,
):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")

    chosen_backend = ai_backend.normalize_backend(backend)
    chosen_model = model or None

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
    chosen_model = (model if model is not None else body.model) or None

    async def gen():
        try:
            async for chunk in asker.ask(
                arxiv_id, body.question, body.history,
                backend=chosen_backend, model=chosen_model,
                display=body.display,
            ):
                yield _sse_format(chunk)
            yield b"event: done\ndata: ok\n\n"
        except Exception as exc:
            err_payload = json.dumps({"message": str(exc)}, ensure_ascii=False)
            yield f"event: error\ndata: {err_payload}\n\n".encode("utf-8")

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/podcast")
async def post_podcast(body: PodcastBody):
    """Generate (or replay) a podcast for a paper. Streams SSE events."""
    chosen_backend = ai_backend.normalize_backend(body.backend)
    chosen_model = body.model or None

    async def gen():
        try:
            async for ev in podcast.generate(
                body.arxiv_id, body.length,
                backend=chosen_backend, model=chosen_model,
            ):
                yield _sse_event(ev)
            yield b"event: done\ndata: ok\n\n"
        except KeyError:
            yield _sse_event({"type": "error", "phase": "input",
                              "message": f"unknown paper: {body.arxiv_id}"})
        except ValueError as exc:
            yield _sse_event({"type": "error", "phase": "input", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001 — surface unexpected failures as SSE
            yield _sse_event({"type": "error", "phase": "internal", "message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")


def _validate_podcast_path(arxiv_id: str, length: str) -> None:
    """Reject bad path params before they reach the filesystem layer.

    `length` must be one of the three known values; `arxiv_id` must not
    contain path-traversal segments (cache_paths re-checks but we want a
    clean 400 instead of a 500 when /api/podcast/..%2Fetc/short.mp3 hits).
    """
    if length not in podcast.LENGTHS:
        raise HTTPException(status_code=400, detail="invalid length")
    if ".." in arxiv_id or "/" in arxiv_id or "\\" in arxiv_id:
        raise HTTPException(status_code=400, detail="invalid arxiv_id")


@app.get("/api/podcast/{arxiv_id}/{length}.mp3")
async def get_podcast_mp3(arxiv_id: str, length: str):
    _validate_podcast_path(arxiv_id, length)
    mp3, _ = podcast.cache_paths(arxiv_id, length)
    if not mp3.exists():
        raise HTTPException(status_code=404, detail="podcast not generated")
    # FileResponse handles Range / 206 partial-content automatically.
    # `inline` so <audio src=...> plays in-page instead of triggering a save.
    return FileResponse(
        mp3,
        media_type="audio/mpeg",
        filename=f"{arxiv_id}-{length}.mp3",
        content_disposition_type="inline",
    )


@app.get("/api/podcast/{arxiv_id}/{length}.json")
async def get_podcast_manifest(arxiv_id: str, length: str):
    _validate_podcast_path(arxiv_id, length)
    manifest = podcast.cached_manifest(arxiv_id, length)
    if manifest is None:
        raise HTTPException(status_code=404, detail="podcast not generated")
    return manifest


@app.delete("/api/podcast/{arxiv_id}/{length}")
async def delete_podcast(arxiv_id: str, length: str):
    _validate_podcast_path(arxiv_id, length)
    return {"removed": podcast.invalidate(arxiv_id, length)}


@app.get("/api/conversations/{arxiv_id}")
async def get_conversations(arxiv_id: str) -> dict:
    rows = conversations.history(arxiv_id)
    return {"messages": [_row_to_dict(r) for r in rows]}


@app.delete("/api/conversations/{arxiv_id}", status_code=204)
async def delete_conversations(arxiv_id: str) -> Response:
    """Clear all persisted chat messages for this paper."""
    conversations.clear(arxiv_id)
    return Response(status_code=204)


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
    """Live arXiv keyword search (title + abstract + authors)."""
    capped = max(1, min(int(limit), 100))
    results = await search.search(q, limit=capped)
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

    # index.html must never be cached — the hashed JS/CSS filenames inside
    # change on every build, and a stale HTML reference will 404 against the
    # new bundle or (worse) boot with old JS. The hashed assets themselves are
    # served by StaticFiles above and can be cached indefinitely by filename.
    _NO_CACHE_HEADERS = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
    }

    @app.get("/", include_in_schema=False)
    async def _index() -> FileResponse:
        return FileResponse(_dist / "index.html", headers=_NO_CACHE_HEADERS)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = _dist / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html", headers=_NO_CACHE_HEADERS)
