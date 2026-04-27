"""Podcast orchestrator: script -> TTS -> ffmpeg concat -> atomic finalize.

Public surface:
  LENGTHS           -- tuple of valid length names ("short", "medium", "long")
  cache_paths()     -- (mp3_path, json_path) for a given arxiv_id + length
  cached_manifest() -- returns JSON dict if both files exist, else None
  invalidate()      -- deletes both files; returns True if anything removed
  generate()        -- async generator yielding typed Event dicts

Failure contract: any error during the pipeline surfaces as an
{"type": "error", ...} event rather than an exception. This keeps the SSE
stream healthy and lets the browser display a user-visible message.

Atomicity contract: the cache is either complete (both .mp3 AND .json exist)
or absent (neither). The two os.rename calls at the very end are the only way
permanent files are created. Between those two renames, the .mp3 exists but
.json does not -- if the process is killed at that exact instant,
cached_manifest() returns None (because it requires both files) and the next
call re-generates. The tmp dir is always cleaned in a finally block regardless
of outcome.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from pathlib import Path
from typing import AsyncIterator, Final, TypedDict

import httpx

from app import ai_backend, papers, pdf_cache
from app.ai_backend import normalize_backend
from app.podcast_segments import split_sentences
from app.tts_client import (
    TtsSynthesisError,
    TtsUnavailableError,
    synthesize,
)


LENGTHS: Final[tuple[str, ...]] = ("short", "medium", "long")
PROMPT_DIR = Path(__file__).parent / "prompts"
DEFAULT_VOICE: Final = "af_bella"
# Word-rate estimate used for progress reporting only -- not actual timing.
WORDS_PER_SECOND_ESTIMATE: Final = 2.5  # ~150 wpm

# Per-(arxiv_id, length) locks -- prevents two concurrent generate() calls
# for the same paper/length from racing over the same tmp dir.
_locks: dict[tuple[str, str], asyncio.Lock] = {}


def _lock_for(key: tuple[str, str]) -> asyncio.Lock:
    return _locks.setdefault(key, asyncio.Lock())


def _data_dir() -> Path:
    return Path(os.environ.get("ATLAS_DATA_DIR", str(Path.home() / ".atlas")))


def cache_paths(arxiv_id: str, length: str) -> tuple[Path, Path]:
    """Return (mp3_path, json_path) -- neither must exist."""
    base = _data_dir() / "podcasts" / arxiv_id
    return base / f"{length}.mp3", base / f"{length}.json"


def cached_manifest(arxiv_id: str, length: str) -> dict | None:
    """Return the JSON manifest dict if both mp3 and json files exist, else None."""
    mp3, jsn = cache_paths(arxiv_id, length)
    if mp3.exists() and jsn.exists():
        return json.loads(jsn.read_text())
    return None


def invalidate(arxiv_id: str, length: str) -> bool:
    """Remove both cache files. Returns True if at least one file was removed."""
    mp3, jsn = cache_paths(arxiv_id, length)
    removed = False
    for p in (mp3, jsn):
        if p.exists():
            p.unlink()
            removed = True
    return removed


def _url(arxiv_id: str, length: str) -> str:
    return f"/api/podcast/{arxiv_id}/{length}.mp3"


class Event(TypedDict, total=False):
    type: str
    text: str
    synthesized_s: float
    total_s_estimate: float
    url: str
    segments: list[dict]
    duration_s: float
    phase: str
    message: str


async def generate(
    arxiv_id: str,
    length: str,
    *,
    backend: str = ai_backend.DEFAULT_BACKEND,
    model: str | None = None,
) -> AsyncIterator[Event]:
    """Drive script -> TTS -> ffmpeg concat -> atomic finalize.

    Yields events of these shapes:
      {"type": "script_chunk",   "text": str}
      {"type": "tts_progress",   "synthesized_s": float, "total_s_estimate": float}
      {"type": "ready",          "url": str, "segments": list[dict], "duration_s": float}
      {"type": "error",          "phase": str, "message": str}

    Raises ValueError if length is invalid; raises KeyError if arxiv_id is not
    in the DB. All other failures (network, TTS, ffmpeg) are reported via
    'error' events so the SSE stream stays healthy.
    """
    if length not in LENGTHS:
        raise ValueError(f"length must be one of {LENGTHS}, got {length!r}")
    if papers.get(arxiv_id) is None:
        raise KeyError(arxiv_id)

    # Fast path: cache hit before touching the lock.
    cached = cached_manifest(arxiv_id, length)
    if cached:
        yield {
            "type": "ready",
            "url": _url(arxiv_id, length),
            "segments": cached["segments"],
            "duration_s": cached["duration_s"],
        }
        return

    async with _lock_for((arxiv_id, length)):
        # Re-check after acquiring -- another coroutine may have just finished.
        cached = cached_manifest(arxiv_id, length)
        if cached:
            yield {
                "type": "ready",
                "url": _url(arxiv_id, length),
                "segments": cached["segments"],
                "duration_s": cached["duration_s"],
            }
            return
        async for ev in _generate_locked(arxiv_id, length, backend, model):
            yield ev


async def _generate_locked(
    arxiv_id: str,
    length: str,
    backend: str,
    model: str | None,
) -> AsyncIterator[Event]:
    """Inner generator -- runs only while the per-key lock is held."""
    mp3, jsn = cache_paths(arxiv_id, length)
    tmp_dir = mp3.parent / f".tmp-{length}"

    try:
        # Phase 1: script generation
        pdf_path = await pdf_cache.ensure_cached(arxiv_id)
        prompt_text = (PROMPT_DIR / f"podcast_{length}.txt").read_text()
        prompt = (
            prompt_text
            + f"\n\nPDF: {pdf_path}\nUse the Read tool to read the PDF before writing."
        )

        script_parts: list[str] = []
        async for chunk in ai_backend.run_ai(
            backend=normalize_backend(backend),
            task="podcast",
            directive="Write the podcast script.",
            prompt=prompt,
            model=model,
            enable_read_file=str(pdf_path),
        ):
            script_parts.append(chunk)
            yield {"type": "script_chunk", "text": chunk}

        script = "".join(script_parts).strip()
        if not script:
            yield {"type": "error", "phase": "script", "message": "empty script"}
            return

        sentences = split_sentences(script)
        if not sentences:
            yield {"type": "error", "phase": "script", "message": "no sentences"}
            return

        # Phase 2: TTS synthesis
        tmp_dir.mkdir(parents=True, exist_ok=True)
        segments: list[dict] = []
        cumulative_ms = 0
        total_words = sum(len(s.split()) for s in sentences)
        total_s_estimate = total_words / WORDS_PER_SECOND_ESTIMATE

        async with httpx.AsyncClient(timeout=60.0) as client:
            for idx, text in enumerate(sentences):
                try:
                    result = await synthesize(text, voice=DEFAULT_VOICE, client=client)
                except (TtsUnavailableError, TtsSynthesisError) as e:
                    yield {"type": "error", "phase": "tts", "message": str(e)}
                    return

                wav_path = tmp_dir / f"{idx:04d}.wav"
                wav_path.write_bytes(result.wav_bytes)

                segments.append({
                    "idx": idx,
                    "text": text,
                    "start_ms": cumulative_ms,
                    "end_ms": cumulative_ms + result.duration_ms,
                })
                cumulative_ms += result.duration_ms

                yield {
                    "type": "tts_progress",
                    "synthesized_s": cumulative_ms / 1000,
                    "total_s_estimate": total_s_estimate,
                }

        # Phase 3: ffmpeg concat
        concat_txt = tmp_dir / "concat.txt"
        concat_txt.write_text(
            "\n".join(
                f"file '{(tmp_dir / f'{i:04d}.wav').resolve()}'"
                for i in range(len(sentences))
            )
        )
        mp3_tmp = tmp_dir / "out.mp3"
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_txt),
            "-c:a", "libmp3lame", "-b:a", "96k",
            str(mp3_tmp),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr_bytes = await proc.communicate()
        if proc.returncode != 0:
            yield {
                "type": "error",
                "phase": "encode",
                "message": stderr_bytes.decode("utf-8", errors="replace")[:500],
            }
            return

        # Phase 4: atomic finalize
        mp3.parent.mkdir(parents=True, exist_ok=True)

        manifest: dict = {
            "arxiv_id": arxiv_id,
            "length": length,
            "voice": DEFAULT_VOICE,
            "model": model or "default",
            "backend": backend,
            "generated_at": int(time.time()),
            "duration_s": cumulative_ms / 1000,
            "script": script,
            "segments": segments,
        }
        jsn_tmp = jsn.with_suffix(".json.tmp")
        jsn_tmp.write_text(json.dumps(manifest))

        # Between these two renames the .mp3 exists but .json does not.
        # If the process is killed here, cached_manifest() returns None
        # (requires both files) and the next request re-generates.
        os.rename(mp3_tmp, mp3)
        os.rename(jsn_tmp, jsn)

        yield {
            "type": "ready",
            "url": _url(arxiv_id, length),
            "segments": segments,
            "duration_s": manifest["duration_s"],
        }

    except Exception as e:  # noqa: BLE001 -- final safety net; errors must be events
        yield {"type": "error", "phase": "internal", "message": str(e)}
    finally:
        # Always clean the tmp dir -- either both .mp3 and .json were renamed
        # into place (success) or neither was (failure); tmp dir is gone either way.
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
