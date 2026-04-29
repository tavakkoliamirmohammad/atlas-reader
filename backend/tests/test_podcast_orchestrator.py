"""Tests for the podcast orchestrator (backend/app/podcast.py).

Covers: cache hit/miss, per-key lock serialization, happy path,
error events (empty script, TTS failure), and cache utility functions.
"""

from __future__ import annotations

import asyncio
import io
import json
import shutil
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator
from unittest.mock import AsyncMock

import pytest

from app import podcast
from app.tts_client import TtsResult, TtsUnavailableError


# ---------------------------------------------------------------------------
# Helper: minimal valid WAV bytes (silence) that ffmpeg can decode
# ---------------------------------------------------------------------------

def _make_wav(duration_ms: int = 1000, sample_rate: int = 24_000) -> bytes:
    """Generate `duration_ms` of silence as a valid WAV blob for ffmpeg."""
    n_samples = int(sample_rate * duration_ms / 1000)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)   # 16-bit PCM
        w.setframerate(sample_rate)
        w.writeframes(b"\x00\x00" * n_samples)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Shared async helper: drain the generator into a list
# ---------------------------------------------------------------------------

async def _drain(gen: AsyncIterator) -> list[dict]:
    events: list[dict] = []
    async for ev in gen:
        events.append(ev)
    return events


# ---------------------------------------------------------------------------
# 1. Invalid length raises ValueError
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_invalid_length_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    with pytest.raises(ValueError):
        async for _ in podcast.generate("2401.00001", "medium-extra"):
            pass


# ---------------------------------------------------------------------------
# 2. Unknown arxiv_id raises KeyError
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unknown_arxiv_id_raises_key_error(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    monkeypatch.setattr("app.papers.get", lambda _: None)
    with pytest.raises(KeyError):
        async for _ in podcast.generate("9999.99999", "short"):
            pass


# ---------------------------------------------------------------------------
# 3. Cache hit returns immediately -- no AI, no TTS
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cache_hit_returns_immediately_no_ai_no_tts(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    # Pre-create the cache files
    mp3_path, json_path = podcast.cache_paths("2401.00001", "short")
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    mp3_path.write_bytes(b"fake-mp3")
    manifest = {
        "arxiv_id": "2401.00001",
        "length": "short",
        "voice": "af_bella",
        "model": "default",
        "backend": "codex",
        "generated_at": 1700000000,
        "duration_s": 2.0,
        "script": "Hello world.",
        "segments": [{"idx": 0, "text": "Hello world.", "start_ms": 0, "end_ms": 2000}],
    }
    json_path.write_text(json.dumps(manifest))

    # These must NOT be called
    monkeypatch.setattr("app.papers.get", lambda _: object())

    def bad_run_ai(**_kwargs):
        raise AssertionError("run_ai must not be called on a cache hit")

    async def bad_synthesize(*_a, **_kw):
        raise AssertionError("synthesize must not be called on a cache hit")

    monkeypatch.setattr("app.ai_backend.run_ai", bad_run_ai)
    monkeypatch.setattr("app.podcast.synthesize", bad_synthesize)

    events = await _drain(podcast.generate("2401.00001", "short"))
    assert len(events) == 1
    assert events[0]["type"] == "ready"
    assert events[0]["duration_s"] == 2.0
    assert events[0]["url"] == "/api/podcast/2401.00001/short.mp3"


# ---------------------------------------------------------------------------
# 4. Happy path (requires ffmpeg)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not available")
@pytest.mark.asyncio
async def test_happy_path(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    # Fake PDF on disk (enable_read_file needs a real path)
    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_bytes(b"%PDF-fake")

    monkeypatch.setattr("app.papers.get", lambda _: object())

    @asynccontextmanager
    async def fake_pdf_for_ai(arxiv_id: str):
        yield fake_pdf

    monkeypatch.setattr("app.pdf_fetch.paper_pdf_for_ai", fake_pdf_for_ai)

    async def fake_run_ai(**kwargs) -> AsyncIterator[str]:
        for chunk in ["First sentence. ", "Second sentence."]:
            yield chunk

    monkeypatch.setattr("app.ai_backend.run_ai", fake_run_ai)

    wav_bytes = _make_wav(duration_ms=1000)

    async def fake_synthesize(text, *, voice, client):
        return TtsResult(wav_bytes=wav_bytes, duration_ms=1000)

    monkeypatch.setattr("app.podcast.synthesize", fake_synthesize)

    events = await _drain(podcast.generate("2401.00001", "short"))

    types = [e["type"] for e in events]
    assert "script_chunk" in types
    assert types.count("tts_progress") == 2
    assert types[-1] == "ready"

    ready = events[-1]
    assert ready["url"] == "/api/podcast/2401.00001/short.mp3"
    assert ready["duration_s"] == pytest.approx(2.0)

    # Files must exist; tmp dir must be gone
    mp3_path, json_path = podcast.cache_paths("2401.00001", "short")
    assert mp3_path.exists()
    assert json_path.exists()
    tmp_dir = mp3_path.parent / ".tmp-short"
    assert not tmp_dir.exists()

    # Verify segment timings
    with open(json_path) as f:
        saved = json.load(f)
    segs = saved["segments"]
    assert len(segs) == 2
    assert segs[0]["start_ms"] == 0
    assert segs[0]["end_ms"] == 1000
    assert segs[1]["start_ms"] == 1000
    assert segs[1]["end_ms"] == 2000


# ---------------------------------------------------------------------------
# 5. Empty script emits error event
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_script_emits_error(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_bytes(b"%PDF-fake")

    monkeypatch.setattr("app.papers.get", lambda _: object())

    @asynccontextmanager
    async def fake_pdf_for_ai(_arxiv_id: str):
        yield fake_pdf

    monkeypatch.setattr("app.pdf_fetch.paper_pdf_for_ai", fake_pdf_for_ai)

    async def fake_run_ai(**kwargs) -> AsyncIterator[str]:
        yield ""

    monkeypatch.setattr("app.ai_backend.run_ai", fake_run_ai)

    events = await _drain(podcast.generate("2401.00001", "short"))
    assert events[-1]["type"] == "error"
    assert events[-1]["phase"] == "script"

    # No permanent files written
    mp3_path, json_path = podcast.cache_paths("2401.00001", "short")
    assert not mp3_path.exists()
    assert not json_path.exists()


# ---------------------------------------------------------------------------
# 6. TTS failure mid-stream cleans up
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tts_failure_mid_stream_cleans_up(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_bytes(b"%PDF-fake")

    monkeypatch.setattr("app.papers.get", lambda _: object())

    @asynccontextmanager
    async def fake_pdf_for_ai(_arxiv_id: str):
        yield fake_pdf

    monkeypatch.setattr("app.pdf_fetch.paper_pdf_for_ai", fake_pdf_for_ai)

    async def fake_run_ai(**kwargs) -> AsyncIterator[str]:
        yield "First sentence. Second sentence."

    monkeypatch.setattr("app.ai_backend.run_ai", fake_run_ai)

    call_count = 0

    async def fake_synthesize(text, *, voice, client):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return TtsResult(wav_bytes=_make_wav(500), duration_ms=500)
        raise TtsUnavailableError("TTS down")

    monkeypatch.setattr("app.podcast.synthesize", fake_synthesize)

    events = await _drain(podcast.generate("2401.00001", "short"))
    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["phase"] == "tts"

    # No permanent files
    mp3_path, json_path = podcast.cache_paths("2401.00001", "short")
    assert not mp3_path.exists()
    assert not json_path.exists()

    # Tmp dir is gone
    tmp_dir = mp3_path.parent / ".tmp-short"
    assert not tmp_dir.exists()


# ---------------------------------------------------------------------------
# 7. Lock serializes concurrent calls; AI called only once
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lock_serializes_concurrent_calls(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_bytes(b"%PDF-fake")

    monkeypatch.setattr("app.papers.get", lambda _: object())

    @asynccontextmanager
    async def fake_pdf_for_ai(_arxiv_id: str):
        yield fake_pdf

    monkeypatch.setattr("app.pdf_fetch.paper_pdf_for_ai", fake_pdf_for_ai)

    ai_call_count = 0

    async def fake_run_ai(**kwargs) -> AsyncIterator[str]:
        nonlocal ai_call_count
        ai_call_count += 1
        await asyncio.sleep(0.05)
        yield "Hello world."

    monkeypatch.setattr("app.ai_backend.run_ai", fake_run_ai)

    wav_bytes = _make_wav(500)

    async def fake_synthesize(text, *, voice, client):
        return TtsResult(wav_bytes=wav_bytes, duration_ms=500)

    monkeypatch.setattr("app.podcast.synthesize", fake_synthesize)

    # Skip ffmpeg if not present -- use a mock that just copies the WAV as "mp3"
    if shutil.which("ffmpeg") is None:
        # Patch the subprocess so the encode step always succeeds by writing a stub mp3
        original_create_subprocess = asyncio.create_subprocess_exec

        async def fake_subprocess(*args, **kwargs):
            # Find the output mp3 path (last positional arg before stdout/stderr kwargs)
            out_path = Path(args[-1])
            out_path.write_bytes(wav_bytes)

            class FakeProc:
                returncode = 0

                async def communicate(self):
                    return b"", b""

            return FakeProc()

        monkeypatch.setattr("asyncio.create_subprocess_exec", fake_subprocess)

    # Fire two concurrent generate() calls for the same (arxiv_id, length)
    results = await asyncio.gather(
        _drain(podcast.generate("2401.00001", "short")),
        _drain(podcast.generate("2401.00001", "short")),
    )

    # AI must have been called exactly once
    assert ai_call_count == 1, f"Expected 1 AI call, got {ai_call_count}"

    # Both calls must end with a ready event
    for events in results:
        assert events[-1]["type"] == "ready"


# ---------------------------------------------------------------------------
# 8. cache_paths respects ATLAS_DATA_DIR
# ---------------------------------------------------------------------------

def test_cache_paths_under_data_dir(monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", "/custom")
    mp3, jsn = podcast.cache_paths("2401.001", "short")
    assert mp3 == Path("/custom/podcasts/2401.001/short.mp3")
    assert jsn == Path("/custom/podcasts/2401.001/short.json")


# ---------------------------------------------------------------------------
# 9. cached_manifest returns None when files are absent
# ---------------------------------------------------------------------------

def test_cached_manifest_returns_none_when_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    assert podcast.cached_manifest("2401.00001", "short") is None


# ---------------------------------------------------------------------------
# 10. cached_manifest returns dict when both files exist
# ---------------------------------------------------------------------------

def test_cached_manifest_returns_dict_when_both_files_exist(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    mp3_path, json_path = podcast.cache_paths("2401.00001", "medium")
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    mp3_path.write_bytes(b"fake")
    data = {"arxiv_id": "2401.00001", "duration_s": 5.0, "segments": []}
    json_path.write_text(json.dumps(data))

    result = podcast.cached_manifest("2401.00001", "medium")
    assert result is not None
    assert result["duration_s"] == 5.0


# ---------------------------------------------------------------------------
# 11. invalidate removes both files; second call returns False
# ---------------------------------------------------------------------------

def test_invalidate_removes_both_files(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    mp3_path, json_path = podcast.cache_paths("2401.00001", "long")
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    mp3_path.write_bytes(b"fake")
    json_path.write_text("{}")

    assert podcast.invalidate("2401.00001", "long") is True
    assert not mp3_path.exists()
    assert not json_path.exists()

    # Second call: nothing to remove
    assert podcast.invalidate("2401.00001", "long") is False


def test_strip_preamble_extracts_between_tags():
    raw = (
        "I'm going to read the PDF and write the script.\n"
        "Pulling the evaluation now.\n"
        "<script>\n"
        "If you've ever planned a huge model run from a handful of smaller runs, "
        "this paper is about the awkward part.\n"
        "</script>\n"
        "Hope you enjoyed it!"
    )
    out = podcast._strip_preamble(raw)
    assert out.startswith("If you've ever planned")
    assert "going to read" not in out
    assert "Hope you enjoyed" not in out


def test_strip_preamble_returns_raw_when_no_tags():
    raw = "If you've ever planned a huge model run, this paper is about that."
    assert podcast._strip_preamble(raw) == raw


def test_strip_preamble_handles_open_tag_only():
    """Model forgot to close — keep everything after the open tag."""
    raw = "<script>\nFirst sentence of the script."
    assert podcast._strip_preamble(raw) == "First sentence of the script."


def test_strip_preamble_handles_inline_tags():
    """Tags don't have to be on their own lines; the matching is positional."""
    raw = "preamble <script>just the script</script> trailing"
    assert podcast._strip_preamble(raw) == "just the script"
