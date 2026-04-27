"""Atlas AI runner — host-only daemon that spawns claude/codex subprocesses.

When Atlas runs inside Docker it cannot reach the host's Keychain creds or the
arm64 CLI binaries, so the backend (with ATLAS_AI_PROXY set) HTTP-streams from
this runner on host.docker.internal:8766 instead of spawning directly.

Hardening (enforced by tests):
- Binds 127.0.0.1 only; host.docker.internal maps back to loopback on Mac.
- Bearer token required on every request.
- Host-header allowlist — DNS-rebinding defense.
- Typed jobs only. No raw argv. No shell.
- Model allowlist per backend. Prompt size cap. Directive length cap.
- Concurrency semaphore + token-bucket rate limiter.
- Per-task timeout; subprocess killed on abandon.
- Codex argv always forces read-only sandbox (ai_argv).
- Claude argv restricts tools to Read when enable_read_file set (ai_argv).
- Structured logging: job_id/task/backend/model/duration/bytes. No prompt text.

Spawning goes through `subprocess_spawn.spawn`, a one-liner wrapper around
asyncio's argv-based async spawner (no shell).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets as _secrets
import time
import uuid
from pathlib import Path
from typing import AsyncIterator, Literal, Optional

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

import uvicorn

from app import ai_argv, ai_local, codex_models, db, port_config, secret_store, subprocess_spawn


log = logging.getLogger("atlas.runner")

# ---------- security constants ----------
ALLOWED_HOSTS = frozenset({"localhost", "127.0.0.1", "host.docker.internal"})
MAX_PROMPT_BYTES = 1 * 1024 * 1024          # 1 MB
MAX_DIRECTIVE_LEN = 512
MAX_READ_PATH_LEN = 1024
CONCURRENCY = 4
RATE_LIMIT_PER_MIN = 30
# Per-readline (stall) timeout — the clock resets every time the subprocess
# emits an NDJSON line. Total wall-clock is unbounded; only true silence kills.
IDLE_TIMEOUT_S = float(os.environ.get("ATLAS_IDLE_TIMEOUT_S", "300"))


# ---------- request model ----------
class RunRequest(BaseModel):
    backend: Literal["claude", "codex"]
    task: Literal["summarize", "ask", "rank", "glossary", "podcast"]
    model: str
    directive: str = Field(min_length=1, max_length=MAX_DIRECTIVE_LEN)
    prompt: str  # sent via subprocess stdin; size checked below
    enable_read_file: Optional[str] = None

    @field_validator("prompt")
    @classmethod
    def _prompt_size(cls, v: str) -> str:
        if len(v.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise ValueError(f"prompt exceeds {MAX_PROMPT_BYTES} bytes")
        return v

    @field_validator("directive")
    @classmethod
    def _directive_safe(cls, v: str) -> str:
        # Defense in depth; ai_argv also rejects leading '-'.
        if v.startswith("-"):
            raise ValueError("directive must not start with '-'")
        return v

    @field_validator("enable_read_file")
    @classmethod
    def _read_path(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        if len(v) > MAX_READ_PATH_LEN:
            raise ValueError("read path too long")
        p = Path(v)
        if not p.is_absolute() or ".." in p.parts:
            raise ValueError("read path must be absolute, no traversal")
        data_root = db.data_dir().resolve()
        try:
            p.resolve().relative_to(data_root)
        except ValueError:
            raise ValueError("read path must live inside ATLAS_DATA_DIR")
        return str(p)


# ---------- rate limiter ----------
class _RateLimiter:
    """Token bucket: `per_minute` tokens, continuous refill."""

    def __init__(self, per_minute: int) -> None:
        self.capacity = per_minute
        self.tokens: float = per_minute
        self.refill_per_sec = per_minute / 60.0
        self.last = time.monotonic()
        self.lock = asyncio.Lock()

    async def allow(self) -> bool:
        async with self.lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.refill_per_sec)
            self.last = now
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False


_sem = asyncio.Semaphore(CONCURRENCY)
_rate = _RateLimiter(RATE_LIMIT_PER_MIN)


# ---------- security middleware ----------
def _check_host(request: Request) -> None:
    host = (request.headers.get("host") or "").split(":", 1)[0].lower()
    if host not in ALLOWED_HOSTS:
        raise HTTPException(status.HTTP_421_MISDIRECTED_REQUEST, detail=f"host {host!r} not allowed")


def _check_auth(request: Request) -> None:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = auth[len("Bearer "):].strip()
    expected = secret_store.load()
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="runner secret not configured")
    if not _secrets.compare_digest(token, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="bad token")


app = FastAPI(title="Atlas AI Runner")


@app.middleware("http")
async def _security(request: Request, call_next):
    try:
        _check_host(request)
        _check_auth(request)
    except HTTPException as exc:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    return await call_next(request)


# ---------- endpoints ----------
@app.get("/health")
async def get_health() -> dict:
    """Report which backend CLIs are usable on the host.

    Codex requires both the binary AND its model cache (`~/.codex/models_cache.json`)
    so the picker has something to populate; otherwise we'd advertise codex as
    available but the user would land on an empty dropdown.
    """
    return {
        "claude": await _probe("claude", ["--version"]),
        "codex": await _probe("codex", ["--version"]) and codex_models.cache_exists(),
    }


@app.get("/models")
async def get_models() -> dict:
    """Return the codex model list. Backend proxies here in Docker mode so we
    don't need to bind-mount `~/.codex/` into the container."""
    try:
        models = codex_models.load()
    except FileNotFoundError:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="codex models cache not found")
    except ValueError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))
    return {"models": models}


async def _probe(cmd: str, args: list[str]) -> bool:
    try:
        proc = await subprocess_spawn.spawn(
            cmd, *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return False
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return False
    return proc.returncode == 0


@app.post("/run")
async def post_run(body: RunRequest) -> StreamingResponse:
    # Rate limit before claiming a concurrency slot.
    if not await _rate.allow():
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail=f"rate limit ({RATE_LIMIT_PER_MIN}/min)")

    # Shape-only model validation (non-empty, no leading '-', length cap).
    # The CLI itself rejects unknown slugs with its own error.
    try:
        ai_argv.validate_model(body.backend, body.model)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))

    job_id = uuid.uuid4().hex[:12]

    async def stream() -> AsyncIterator[bytes]:
        started = time.monotonic()
        status_tag = "ok"
        bytes_out = 0
        try:
            async with _sem:
                async for event in _run_job(body, IDLE_TIMEOUT_S):
                    data = json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n"
                    bytes_out += len(data)
                    yield data
        except asyncio.TimeoutError:
            status_tag = "idle_timeout"
            yield (json.dumps({"type": "error", "message": "idle timeout"}) + "\n").encode("utf-8")
        except Exception as exc:          # noqa: BLE001
            status_tag = "error"
            log.exception("job %s failed", job_id)
            yield (json.dumps({"type": "error", "message": str(exc)}) + "\n").encode("utf-8")
        finally:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            log.info(
                "job=%s task=%s backend=%s model=%s status=%s duration_ms=%d bytes_out=%d",
                job_id, body.task, body.backend, body.model, status_tag, elapsed_ms, bytes_out,
            )

    return StreamingResponse(stream(), media_type="application/x-ndjson")


async def _run_job(body: RunRequest, idle_timeout_s: float) -> AsyncIterator[dict]:
    """Wrap the shared streamer and frame each chunk as an NDJSON text event."""
    async for text in ai_local.stream_text(
        backend=body.backend,
        task=body.task,
        model=body.model,
        directive=body.directive,
        prompt=body.prompt,
        enable_read_file=body.enable_read_file,
        idle_timeout_s=idle_timeout_s,
    ):
        yield {"type": "text", "text": text}


def main() -> None:
    """Entry point for the `atlas-ai-runner` console script."""
    logging.basicConfig(
        level=os.environ.get("ATLAS_RUNNER_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if secret_store.load() is None:
        raise SystemExit(
            "atlas-ai-runner: no secret found. Run `atlas up` first, or "
            "set ATLAS_AI_SECRET in the environment."
        )
    host = os.environ.get("ATLAS_RUNNER_HOST", "127.0.0.1")
    port = port_config.runner_port()
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
