"""Async wrapper around `claude -p` subprocess. Yields stdout chunks."""

from __future__ import annotations

import asyncio
from typing import AsyncIterator, Optional, Sequence


MAX_CONCURRENT = 4
_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT)


class ClaudeSubprocessError(RuntimeError):
    """Raised when `claude -p` exits non-zero."""


async def run_streaming(
    args: Sequence[str],
    stdin_text: Optional[str] = None,
) -> AsyncIterator[str]:
    """Spawn `claude` with `args`, yield stdout chunks as decoded strings.

    Caps concurrent invocations at MAX_CONCURRENT. Raises ClaudeSubprocessError
    if the subprocess exits non-zero (after streaming completes).
    """
    async with _SEMAPHORE:
        # Note: create_subprocess_exec is the safe, non-shell variant of subprocess
        # spawning. It uses execvp under the hood; no shell is involved, so command
        # injection via `args` is not possible.
        proc = await asyncio.create_subprocess_exec(
            "claude", *args,
            stdin=asyncio.subprocess.PIPE if stdin_text is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if stdin_text is not None and proc.stdin is not None:
            proc.stdin.write(stdin_text.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()

        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.readline()
            if not chunk:
                break
            yield chunk.decode("utf-8", errors="replace")

        await proc.wait()
        if proc.returncode != 0:
            stderr_bytes = await proc.stderr.read() if proc.stderr else b""
            raise ClaudeSubprocessError(
                f"claude exited {proc.returncode}: {stderr_bytes.decode('utf-8', 'replace')}"
            )
