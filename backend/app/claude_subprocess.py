"""Async wrapper around `claude -p` subprocess. Yields TEXT chunks as they stream.

We invoke claude with `--output-format stream-json --verbose --include-partial-messages`
so the CLI emits NDJSON delta events as the model produces tokens, rather than buffering
the whole response and dumping it at the end. Each line is a JSON event; we extract
text deltas (`stream_event` -> `content_block_delta` -> `text_delta`) and yield them.

Falls back to emitting the final `assistant` message if no deltas were ever observed
(in case the local claude CLI version doesn't support partial messages).
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator, Optional, Sequence


MAX_CONCURRENT = 4
_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT)

# Flags that turn `claude -p` into a real streaming source.
_STREAM_FLAGS = (
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
)


class ClaudeSubprocessError(RuntimeError):
    """Raised when `claude -p` exits non-zero."""


def _extract_text(event: dict) -> Optional[str]:
    """Pull text from a Claude stream-json delta event, or return None."""
    if event.get("type") == "stream_event":
        ev = event.get("event") or {}
        if ev.get("type") == "content_block_delta":
            delta = ev.get("delta") or {}
            if delta.get("type") == "text_delta":
                return delta.get("text") or ""
    return None


def _final_message_text(event: dict) -> Optional[str]:
    """Pull text from a final 'assistant' message (fallback when no deltas seen)."""
    if event.get("type") != "assistant":
        return None
    msg = event.get("message") or {}
    parts: list[str] = []
    for block in msg.get("content") or []:
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
    return "".join(parts) or None


async def run_streaming(
    args: Sequence[str],
    stdin_text: Optional[str] = None,
) -> AsyncIterator[str]:
    """Spawn `claude` with `args` (plus streaming flags), yield text chunks as they arrive."""
    full_args = [*args, *_STREAM_FLAGS]
    async with _SEMAPHORE:
        proc = await asyncio.create_subprocess_exec(
            "claude", *full_args,
            stdin=asyncio.subprocess.PIPE if stdin_text is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if stdin_text is not None and proc.stdin is not None:
            proc.stdin.write(stdin_text.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()

        assert proc.stdout is not None

        seen_delta = False
        deferred: Optional[str] = None

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

            text = _extract_text(event)
            if text:
                seen_delta = True
                yield text
                continue

            final = _final_message_text(event)
            if final:
                deferred = final

        if not seen_delta and deferred:
            yield deferred

        await proc.wait()
        if proc.returncode != 0:
            stderr_bytes = await proc.stderr.read() if proc.stderr else b""
            raise ClaudeSubprocessError(
                f"claude exited {proc.returncode}: {stderr_bytes.decode('utf-8', 'replace')}"
            )
