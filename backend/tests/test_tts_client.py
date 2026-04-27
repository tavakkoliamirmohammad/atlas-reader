from __future__ import annotations

import json

import httpx
import pytest

from app import tts_client
from app.tts_client import (
    TtsResult,
    TtsSynthesisError,
    TtsUnavailableError,
    health_ok,
    synthesize,
)


def _client(handler) -> httpx.AsyncClient:
    """Build an AsyncClient backed by a MockTransport — no real network."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_synthesize_happy_path():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/synthesize"
        assert request.headers["content-type"].startswith("application/json")
        # The wav bytes are arbitrary; the client only forwards them.
        return httpx.Response(
            200,
            content=b"RIFF\x00\x00\x00\x00WAVE_fake_",
            headers={"X-Audio-Duration-Ms": "1234"},
        )

    async with _client(handler) as c:
        result = await synthesize("hello", client=c)

    assert isinstance(result, TtsResult)
    assert result.wav_bytes.startswith(b"RIFF")
    assert result.duration_ms == 1234


async def test_synthesize_passes_voice():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, content=b"RIFF", headers={"X-Audio-Duration-Ms": "10"})

    async with _client(handler) as c:
        await synthesize("hi", voice="am_adam", client=c)

    assert captured == {"text": "hi", "voice": "am_adam"}


async def test_synthesize_default_voice():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, content=b"RIFF", headers={"X-Audio-Duration-Ms": "10"})

    async with _client(handler) as c:
        await synthesize("hi", client=c)

    assert captured["voice"] == "af_bella"


async def test_synthesize_connect_error_raises_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    async with _client(handler) as c:
        with pytest.raises(TtsUnavailableError):
            await synthesize("hi", client=c)


async def test_synthesize_read_timeout_raises_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    async with _client(handler) as c:
        with pytest.raises(TtsUnavailableError) as exc_info:
            await synthesize("hi", client=c)
    assert "ReadTimeout" in str(exc_info.value)


async def test_synthesize_malformed_duration_header_returns_zero():
    def handler(request: httpx.Request) -> httpx.Response:
        # Some sidecar versions might emit a float string by mistake.
        return httpx.Response(200, content=b"RIFF", headers={"X-Audio-Duration-Ms": "1234.5"})

    async with _client(handler) as c:
        result = await synthesize("hi", client=c)
    assert result.duration_ms == 0


async def test_synthesize_5xx_raises_synthesis_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    async with _client(handler) as c:
        with pytest.raises(TtsSynthesisError) as exc_info:
            await synthesize("hi", client=c)
    assert "500" in str(exc_info.value)


async def test_synthesize_4xx_raises_synthesis_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, text="bad input")

    async with _client(handler) as c:
        with pytest.raises(TtsSynthesisError) as exc_info:
            await synthesize("hi", client=c)
    assert "422" in str(exc_info.value)


async def test_health_ok_true_on_200():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200, json={"status": "ok"})

    async with _client(handler) as c:
        assert await health_ok(client=c) is True


async def test_health_ok_false_on_5xx():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    async with _client(handler) as c:
        assert await health_ok(client=c) is False


async def test_health_ok_false_on_connect_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async with _client(handler) as c:
        assert await health_ok(client=c) is False


def test_tts_url_uses_env(monkeypatch):
    monkeypatch.setenv("ATLAS_TTS_URL", "http://example.invalid:9999")
    assert tts_client.tts_url() == "http://example.invalid:9999"


def test_tts_url_default(monkeypatch):
    monkeypatch.delenv("ATLAS_TTS_URL", raising=False)
    assert tts_client.tts_url() == "http://tts:8767"
