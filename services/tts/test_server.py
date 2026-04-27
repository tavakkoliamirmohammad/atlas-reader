from __future__ import annotations

import os

import httpx
import pytest

URL = os.environ.get("TTS_TEST_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TTS_TEST_URL not set")


def test_health():
    r = httpx.get(f"{URL}/health", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "voice" in body


def test_synth_returns_wav():
    r = httpx.post(f"{URL}/synthesize", json={"text": "Hello world."}, timeout=60)
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    # RIFF/WAVE magic bytes
    assert r.content[:4] == b"RIFF"
    assert r.content[8:12] == b"WAVE"
    assert int(r.headers["X-Audio-Duration-Ms"]) > 0


def test_empty_text_rejected():
    r = httpx.post(f"{URL}/synthesize", json={"text": ""}, timeout=10)
    # Pydantic min_length=1 returns 422
    assert r.status_code == 422


def test_oversize_text_rejected():
    r = httpx.post(f"{URL}/synthesize", json={"text": "a" * 5001}, timeout=10)
    assert r.status_code == 422
