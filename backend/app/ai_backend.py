"""Single entry point for all AI calls — dispatches host-local or to the runner.

When `ATLAS_AI_PROXY` is set (Docker mode), stream chunks over HTTP from the
atlas-ai-runner daemon on the host. Otherwise (host mode), spawn the CLI
directly via `ai_local.stream_text`. Both paths yield plain `str` chunks.

Callers:
- summarizer.summarize, asker.ask, ranker.score_papers, glossary.extract_terms,
  glossary.define — each now takes a `backend` parameter threaded from the API.
"""

from __future__ import annotations

import json
import os
from typing import AsyncIterator, Literal, Optional

import httpx

from app import ai_local, codex_models, secret_store


Backend = Literal["claude", "codex"]
Task = Literal["summarize", "ask", "rank", "glossary"]


# Claude defaults are aliases — the Anthropic CLI auto-resolves each to the
# latest concrete model, so this set never goes stale.
_CLAUDE_DEFAULTS: dict[Task, str] = {
    "summarize": "opus", "ask": "sonnet", "rank": "haiku", "glossary": "sonnet",
}
# Codex last-resort fallback when the cache is unreadable. Picked because it's
# been the codex CLI's stable mid-tier for a while; if it gets retired, the
# dynamic lookup below picks the new top model from the cache instead.
_CODEX_FALLBACK = "gpt-5.4"

DEFAULT_BACKEND: Backend = "codex"

# httpx timeout for the proxy stream — applied per-read of the runner's
# response body. Mirrors the runner's idle timeout so the HTTP layer doesn't
# give up before the runner does.
PROXY_IDLE_TIMEOUT_S = float(os.environ.get("ATLAS_IDLE_TIMEOUT_S", "300"))


async def default_model(backend: Backend, task: Task) -> str:
    """Pick a default when the caller didn't supply a model.

    Claude uses stable aliases that auto-resolve to the latest model. Codex
    derives from the host's `models_cache.json` (the same source the picker
    reads), so a retired hardcoded slug can never sneak into production.
    Falls back to `_CODEX_FALLBACK` only when the cache is unreadable.
    """
    if backend == "claude":
        return _CLAUDE_DEFAULTS[task]
    try:
        if os.environ.get("ATLAS_AI_PROXY"):
            models = await codex_models_via_runner()
        else:
            models = [dict(m) for m in codex_models.load()]
    except Exception:                      # noqa: BLE001
        return _CODEX_FALLBACK
    if not models:
        return _CODEX_FALLBACK
    # Cheaper tier for non-interactive jobs (rank, glossary). models is
    # priority-ascending in codex_models.load, so [0] is the top tier and [-1]
    # is the cheapest.
    cheap = task in ("rank", "glossary")
    return str((models[-1] if cheap and len(models) > 1 else models[0]).get("slug") or _CODEX_FALLBACK)


def normalize_backend(value: Optional[str]) -> Backend:
    """Turn an untrusted string into a known backend, falling back to default."""
    if value in ("claude", "codex"):
        return value  # type: ignore[return-value]
    return DEFAULT_BACKEND


async def run_ai(
    *,
    backend: Backend,
    task: Task,
    directive: str,
    prompt: str,
    model: Optional[str] = None,
    enable_read_file: Optional[str] = None,
) -> AsyncIterator[str]:
    """Yield text chunks from the chosen backend."""
    chosen_model = model or await default_model(backend, task)
    proxy_url = os.environ.get("ATLAS_AI_PROXY")
    if proxy_url:
        async for chunk in _run_proxy(
            proxy_url, backend, task, chosen_model, directive, prompt, enable_read_file,
        ):
            yield chunk
        return
    async for chunk in ai_local.stream_text(
        backend=backend,
        task=task,
        model=chosen_model,
        directive=directive,
        prompt=prompt,
        enable_read_file=enable_read_file,
    ):
        yield chunk


async def _run_proxy(
    base_url: str,
    backend: str,
    task: str,
    model: str,
    directive: str,
    prompt: str,
    enable_read_file: Optional[str],
) -> AsyncIterator[str]:
    """Stream NDJSON from the host runner, yield text chunks."""
    secret = secret_store.load()
    if not secret:
        raise RuntimeError(
            "ATLAS_AI_PROXY is set but no ATLAS_AI_SECRET is available to the backend"
        )
    payload = {
        "backend": backend,
        "task": task,
        "model": model,
        "directive": directive,
        "prompt": prompt,
    }
    if enable_read_file is not None:
        payload["enable_read_file"] = enable_read_file

    url = base_url.rstrip("/") + "/run"
    headers = {"Authorization": f"Bearer {secret}"}

    # connect/read/write/pool: only the read deadline matters here, since the
    # runner streams NDJSON as it arrives. Pool/connect can be small.
    timeout = httpx.Timeout(connect=10.0, read=PROXY_IDLE_TIMEOUT_S, write=30.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                detail = (await resp.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"runner returned {resp.status_code}: {detail}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "text":
                    text = event.get("text") or ""
                    if text:
                        yield text
                elif event.get("type") == "error":
                    raise RuntimeError(f"runner error: {event.get('message', 'unknown')}")


async def codex_models_via_runner() -> list[dict]:
    """Fetch codex model list via the runner. Used by `/api/models` in Docker
    mode so the container doesn't need a bind-mount of `~/.codex/`.

    Raises `RuntimeError` (no proxy / no secret), `httpx.HTTPStatusError`
    (runner returned non-2xx), or `httpx.RequestError` (network).
    """
    proxy_url = os.environ.get("ATLAS_AI_PROXY")
    if not proxy_url:
        raise RuntimeError("not in proxy mode")
    secret = secret_store.load()
    if not secret:
        raise RuntimeError("no runner secret available")
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            proxy_url.rstrip("/") + "/models",
            headers={"Authorization": f"Bearer {secret}"},
        )
        r.raise_for_status()
        data = r.json()
        return list(data.get("models", []))


async def available_backends() -> dict[str, bool]:
    """Return {claude: bool, codex: bool}.

    Codex is only "available" if both the binary works AND the codex models
    cache exists, since without the cache the picker has nothing to populate.
    The runner reports the same combined boolean in proxy mode.
    """
    proxy_url = os.environ.get("ATLAS_AI_PROXY")
    if proxy_url:
        secret = secret_store.load()
        if not secret:
            return {"claude": False, "codex": False}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(
                    proxy_url.rstrip("/") + "/health",
                    headers={"Authorization": f"Bearer {secret}"},
                )
                r.raise_for_status()
                data = r.json()
                return {
                    "claude": bool(data.get("claude")),
                    "codex": bool(data.get("codex")),
                }
        except Exception:                  # noqa: BLE001
            return {"claude": False, "codex": False}
    # Host mode: probe directly.
    return {
        "claude": await _local_cli_ok("claude"),
        "codex": await _local_cli_ok("codex") and codex_models.cache_exists(),
    }


async def _local_cli_ok(cmd: str) -> bool:
    import asyncio as _asyncio
    from app import subprocess_spawn as _spawn
    try:
        proc = await _spawn.spawn(
            cmd, "--version",
            stdout=_asyncio.subprocess.DEVNULL,
            stderr=_asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return False
    try:
        await _asyncio.wait_for(proc.wait(), timeout=5)
    except _asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return False
    return proc.returncode == 0
