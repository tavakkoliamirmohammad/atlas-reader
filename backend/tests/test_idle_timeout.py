"""Idle/stall timeout for ai_local.stream_text.

These tests assert that the timeout fires only when the subprocess is silent
for `idle_timeout_s`, not when it has merely been running a long time. A
process that keeps streaming chunks must NEVER be killed by the idle clock.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator, Iterable

import pytest

from app import ai_local, subprocess_spawn


# ---------- fake subprocess ----------

class _FakeStdout:
    """Async-readable that yields pre-scheduled chunks with optional delays.

    `script` is a list of (delay_seconds, line_or_None). A line of None means
    EOF (readline returns b''). Delays are awaited before the line is returned.
    """

    def __init__(self, script: Iterable[tuple[float, str | None]]) -> None:
        self._script: list[tuple[float, str | None]] = list(script)
        self._idx = 0

    async def readline(self) -> bytes:
        if self._idx >= len(self._script):
            return b""
        delay, line = self._script[self._idx]
        self._idx += 1
        if delay > 0:
            await asyncio.sleep(delay)
        if line is None:
            return b""
        return (line + "\n").encode("utf-8")


class _FakeStderr:
    async def read(self) -> bytes:
        return b""


class _FakeStdin:
    def __init__(self) -> None:
        self.written = b""
        self.closed = False

    def write(self, data: bytes) -> None:
        self.written += data

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class _FakeProc:
    def __init__(self, stdout_script: Iterable[tuple[float, str | None]]) -> None:
        self.stdin = _FakeStdin()
        self.stdout = _FakeStdout(stdout_script)
        self.stderr = _FakeStderr()
        self.returncode: int | None = None
        self.killed = False

    def kill(self) -> None:
        self.killed = True
        if self.returncode is None:
            self.returncode = -9

    async def wait(self) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


def _claude_chunk(text: str) -> str:
    """Build a claude stream-json line carrying a text delta (the shape
    ai_stream.extract recognises for backend='claude')."""
    return json.dumps({
        "type": "stream_event",
        "event": {
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": text},
        },
    })


def _install_fake_proc(monkeypatch, script):
    proc_holder: dict[str, _FakeProc] = {}

    async def fake_spawn(*_argv, **_kwargs):
        proc = _FakeProc(script)
        proc_holder["proc"] = proc
        return proc

    monkeypatch.setattr(subprocess_spawn, "spawn", fake_spawn)
    return proc_holder


# ---------- tests ----------

async def _collect(stream: AsyncIterator[str]) -> list[str]:
    out: list[str] = []
    async for chunk in stream:
        out.append(chunk)
    return out


async def test_idle_timeout_kills_silent_process(monkeypatch):
    """No output for longer than idle_timeout_s ⇒ proc killed, error raised."""
    # 0.5 s silence then a chunk. With idle=0.1 we should give up before the chunk.
    holder = _install_fake_proc(monkeypatch, [(0.5, _claude_chunk("late"))])

    with pytest.raises(asyncio.TimeoutError):
        await _collect(ai_local.stream_text(
            backend="claude", task="summarize", model="opus",
            directive="Summarize.", prompt="P",
            idle_timeout_s=0.1,
        ))

    assert holder["proc"].killed, "subprocess must be killed on idle timeout"


async def test_idle_timeout_resets_on_chunk(monkeypatch):
    """A process that streams chunks faster than idle_timeout_s never times out,
    even when total elapsed time exceeds the idle threshold."""
    # Five chunks, each preceded by a 0.05 s wait. Total ≈ 0.25 s. Idle = 0.1 s.
    # No single gap exceeds 0.1 s ⇒ must complete cleanly.
    script = [
        (0.05, _claude_chunk("a")),
        (0.05, _claude_chunk("b")),
        (0.05, _claude_chunk("c")),
        (0.05, _claude_chunk("d")),
        (0.05, _claude_chunk("e")),
        (0.0, None),  # EOF
    ]
    _install_fake_proc(monkeypatch, script)

    chunks = await _collect(ai_local.stream_text(
        backend="claude", task="summarize", model="opus",
        directive="Summarize.", prompt="P",
        idle_timeout_s=0.1,
    ))

    assert chunks == ["a", "b", "c", "d", "e"]


async def test_idle_timeout_fires_after_initial_chunks(monkeypatch):
    """Stalls part-way through still kill the process — the clock resets, but
    a new gap larger than idle_timeout_s still fires."""
    script = [
        (0.0,  _claude_chunk("a")),    # immediate
        (0.0,  _claude_chunk("b")),    # immediate
        (0.5,  _claude_chunk("c")),    # 0.5 s gap >> 0.1 s idle ⇒ kill here
    ]
    holder = _install_fake_proc(monkeypatch, script)

    chunks: list[str] = []
    with pytest.raises(asyncio.TimeoutError):
        async for c in ai_local.stream_text(
            backend="claude", task="summarize", model="opus",
            directive="Summarize.", prompt="P",
            idle_timeout_s=0.1,
        ):
            chunks.append(c)

    # The first two chunks made it through before the stall.
    assert chunks == ["a", "b"]
    assert holder["proc"].killed
