"""Tests for the narration-strip filter that sits over the raw AI stream."""

from __future__ import annotations

from typing import AsyncIterator

import pytest

from app import asker


async def _stream(parts: list[str]) -> AsyncIterator[str]:
    for p in parts:
        yield p


async def _collect(stream: AsyncIterator[str]) -> str:
    out: list[str] = []
    async for x in stream:
        out.append(x)
    return "".join(out)


@pytest.mark.asyncio
async def test_strips_codex_sandbox_fallback_message():
    chunks = [
        "The PDF extraction path hit a sandbox issue, so I'm switching to "
        "a local text-extraction route to get the section content directly.\n\n",
        "The paper proposes a new tile-and-fuse pass for MLIR.",
    ]
    out = await _collect(asker._strip_narration(_stream(chunks)))
    assert out == "The paper proposes a new tile-and-fuse pass for MLIR."


@pytest.mark.asyncio
async def test_strips_multiple_narration_sentences():
    chunks = [
        "I'm going to read the PDF. ",
        "I'll pull the evaluation details now.\n\n",
        "Section 4 reports a 1.7x speedup over the cuBLAS baseline.",
    ]
    out = await _collect(asker._strip_narration(_stream(chunks)))
    assert out == "Section 4 reports a 1.7x speedup over the cuBLAS baseline."


@pytest.mark.asyncio
async def test_passthrough_when_no_narration():
    chunks = ["The authors introduce a new MLIR dialect.\n\n", "It targets GPU codegen."]
    out = await _collect(asker._strip_narration(_stream(chunks)))
    assert out == "The authors introduce a new MLIR dialect.\n\nIt targets GPU codegen."


@pytest.mark.asyncio
async def test_decision_buffer_caps_at_1200_chars_without_paragraph_break():
    """A model that never breaks paragraphs still gets emitted (eventually)."""
    long_chunk = "x" * 1500
    out = await _collect(asker._strip_narration(_stream([long_chunk, " end"])))
    # No narration matched, so the full payload comes through.
    assert out == "x" * 1500 + " end"


@pytest.mark.asyncio
async def test_does_not_eat_legitimate_let_me_explain():
    """A real answer that starts with 'Let me explain' should not be stripped."""
    chunks = [
        "Let me explain the core idea. ",
        "The pass tiles loops then fuses producers into consumers.\n\n",
        "This avoids materializing intermediate tensors.",
    ]
    out = await _collect(asker._strip_narration(_stream(chunks)))
    assert "Let me explain the core idea." in out
    assert "fuses producers" in out


@pytest.mark.asyncio
async def test_preserves_tail_after_paragraph_break():
    """Content after the first paragraph break is never buffered or stripped."""
    chunks = [
        "Reading section 4.\n\n",
        "## Result\n\nA 1.7x speedup.",
    ]
    out = await _collect(asker._strip_narration(_stream(chunks)))
    assert out == "## Result\n\nA 1.7x speedup."


@pytest.mark.asyncio
async def test_empty_stream_yields_nothing():
    out = await _collect(asker._strip_narration(_stream([])))
    assert out == ""
