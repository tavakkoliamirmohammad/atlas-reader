from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final

import httpx

DEFAULT_TIMEOUT_S: Final = 60.0
DEFAULT_VOICE: Final = "af_bella"


class TtsUnavailableError(RuntimeError):
    """The TTS sidecar is unreachable (network error, container down, etc.)."""


class TtsSynthesisError(RuntimeError):
    """The TTS sidecar returned a non-2xx response."""


@dataclass(frozen=True, slots=True)
class TtsResult:
    wav_bytes: bytes
    duration_ms: int


def tts_url() -> str:
    """The base URL of the TTS sidecar. Reads ATLAS_TTS_URL or falls back to compose default."""
    return os.environ.get("ATLAS_TTS_URL", "http://tts:8767")


async def synthesize(
    text: str,
    *,
    voice: str = DEFAULT_VOICE,
    client: httpx.AsyncClient | None = None,
) -> TtsResult:
    """Synthesize a single sentence to WAV bytes.

    `client` is optional — pass one in to share connection pooling across many
    calls (the orchestrator does this) or omit to get a one-shot client.
    """
    payload = {"text": text, "voice": voice}
    own_client = client is None
    c = client or httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S)
    try:
        try:
            response = await c.post(f"{tts_url()}/synthesize", json=payload)
        except httpx.HTTPError as e:
            # Covers ConnectError, ReadTimeout, ReadError, RemoteProtocolError,
            # PoolTimeout — anything that means "we never got a usable response."
            raise TtsUnavailableError(
                f"TTS service unreachable at {tts_url()}: {type(e).__name__}"
            ) from e
    finally:
        if own_client:
            await c.aclose()
    if response.status_code >= 400:
        snippet = response.text[:200] if response.text else ""
        raise TtsSynthesisError(f"TTS returned {response.status_code}: {snippet}")
    try:
        duration_ms = int(response.headers.get("X-Audio-Duration-Ms", "0"))
    except ValueError:
        duration_ms = 0
    return TtsResult(wav_bytes=response.content, duration_ms=duration_ms)


async def health_ok(*, client: httpx.AsyncClient | None = None) -> bool:
    """Return True if the sidecar's /health responds 200, False otherwise.

    Used by /api/health to surface TTS availability. Never raises — connection
    errors are translated to False.
    """
    own_client = client is None
    c = client or httpx.AsyncClient(timeout=2.0)
    try:
        try:
            response = await c.get(f"{tts_url()}/health")
        except (httpx.HTTPError, OSError):
            return False
        return response.status_code == 200
    finally:
        if own_client:
            await c.aclose()
