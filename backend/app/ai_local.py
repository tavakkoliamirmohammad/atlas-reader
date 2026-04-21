"""Spawn a claude/codex subprocess locally and stream text chunks.

This is the shared core used by:
- `runner_main._run_job` (when the runner daemon accepts a proxied job)
- `ai_backend.run_ai` in host mode (when the backend spawns directly, no proxy)

Contracts:
- Yields plain `str` chunks as they arrive.
- Applies the same argv construction via `ai_argv.build_argv`, so the security
  flags (codex read-only sandbox, claude Read-only tools) are guaranteed the
  same in both paths.
- Raises `RuntimeError` on non-zero exit; the caller is responsible for
  translating that into a user-visible error.
- Honors the caller-supplied `timeout_s` via `asyncio.timeout`.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import AsyncIterator, Optional

from app import ai_argv, ai_stream, db, subprocess_spawn


async def stream_text(
    backend: str,
    task: str,
    model: str,
    directive: str,
    prompt: str,
    enable_read_file: Optional[str] = None,
    timeout_s: float = 180.0,
) -> AsyncIterator[str]:
    """Yield text chunks from claude/codex as they stream.

    `enable_read_file` — when set, the argv builder enables the Read tool
    (claude) or leaves the read-only sandbox enabled (codex). The actual path
    is not passed on the command line; the prompt already references it.
    """
    argv = ai_argv.build_argv(
        backend=backend,          # type: ignore[arg-type]
        task=task,                # type: ignore[arg-type]
        model=model,
        directive=directive,
        enable_read_file=enable_read_file is not None,
    )
    cwd = str(db.data_dir())

    proc = await subprocess_spawn.spawn(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        limit=10 * 1024 * 1024,
    )
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None

    proc.stdin.write(prompt.encode("utf-8"))
    await proc.stdin.drain()
    proc.stdin.close()

    seen_delta = False
    deferred_final: Optional[str] = None
    captured_error: Optional[str] = None

    try:
        async with asyncio.timeout(timeout_s):
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Codex reports errors in the stdout stream, not stderr — so
                # check for an error event before treating it like a text event.
                if backend == "codex":
                    err_msg = ai_stream.codex_error(event)
                    if err_msg:
                        captured_error = err_msg

                delta, final = ai_stream.extract(backend, event)
                if delta:
                    seen_delta = True
                    yield delta
                    continue
                if final is not None:
                    deferred_final = final

            if not seen_delta and deferred_final:
                yield deferred_final

            await proc.wait()
            if proc.returncode != 0:
                if captured_error:
                    raise RuntimeError(f"{backend}: {captured_error}")
                err = (await proc.stderr.read()).decode("utf-8", errors="replace")
                raise RuntimeError(f"{backend} exited {proc.returncode}: {err[:500]}")
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await proc.wait()
            except Exception:              # noqa: BLE001
                pass
