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

from app import ai_local, secret_store


Backend = Literal["claude", "codex"]
Task = Literal["summarize", "ask", "rank", "glossary"]


# Per-(backend, task) default model. Claude has established Atlas conventions;
# Codex v1 maps every task to `gpt-5` — we can differentiate later if needed.
_DEFAULT_MODELS: dict[Backend, dict[Task, str]] = {
    "claude": {"summarize": "opus", "ask": "sonnet", "rank": "haiku", "glossary": "sonnet"},
    # gpt-5.4 is the current flagship; gpt-5.4-mini is the cheap tier that
    # actually works on ChatGPT plans (gpt-5.1-codex-mini is listed in the
    # codex CLI selector but rejected by the API for ChatGPT accounts).
    "codex":  {
        "summarize": "gpt-5.4",
        "ask":       "gpt-5.4",
        "rank":      "gpt-5.4-mini",
        "glossary":  "gpt-5.4-mini",
    },
}

DEFAULT_BACKEND: Backend = "codex"

PROXY_TIMEOUT_S = 240.0       # overall per-task cap; runner has its own per-task timeout


def default_model(backend: Backend, task: Task) -> str:
    return _DEFAULT_MODELS[backend][task]


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
    chosen_model = model or default_model(backend, task)
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

    async with httpx.AsyncClient(timeout=PROXY_TIMEOUT_S) as client:
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


async def available_backends() -> dict[str, bool]:
    """Return {claude: bool, codex: bool}. In proxy mode, ask the runner."""
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
        "codex": await _local_cli_ok("codex"),
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
