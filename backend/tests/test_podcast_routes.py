"""Tests for the podcast HTTP routes added in Task 7."""

from __future__ import annotations

import json
from pathlib import Path
from typing import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import podcast


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# POST /api/podcast — SSE streaming
# ---------------------------------------------------------------------------


async def _gen_two_events(*_args, **_kwargs) -> AsyncIterator[dict]:
    yield {"type": "script_chunk", "text": "hi"}
    yield {"type": "ready", "url": "/api/podcast/x/short.mp3", "segments": [], "duration_s": 0}


def test_post_podcast_streams_events(client: TestClient, monkeypatch):
    monkeypatch.setattr(podcast, "generate", _gen_two_events)

    r = client.post("/api/podcast", json={"arxiv_id": "x", "length": "short"})
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    body = r.text
    assert "script_chunk" in body
    assert "ready" in body


async def _gen_key_error(arxiv_id, length, **_kwargs) -> AsyncIterator[dict]:
    raise KeyError(arxiv_id)
    # satisfy the type checker — unreachable
    yield {}  # type: ignore[misc]


def test_post_podcast_unknown_arxiv_id_returns_error_event(client: TestClient, monkeypatch):
    monkeypatch.setattr(podcast, "generate", _gen_key_error)

    r = client.post("/api/podcast", json={"arxiv_id": "x", "length": "short"})
    assert r.status_code == 200
    body = r.text
    assert '"type": "error"' in body
    assert '"phase": "input"' in body
    assert "unknown paper" in body


def test_post_podcast_invalid_length_returns_422(client: TestClient):
    r = client.post("/api/podcast", json={"arxiv_id": "x", "length": "huge"})
    assert r.status_code == 422


async def _gen_runtime_error(*_args, **_kwargs) -> AsyncIterator[dict]:
    raise RuntimeError("boom")
    yield {}  # type: ignore[misc]


def test_post_podcast_unexpected_exception_surfaces_as_error_event(
    client: TestClient, monkeypatch
):
    monkeypatch.setattr(podcast, "generate", _gen_runtime_error)

    r = client.post("/api/podcast", json={"arxiv_id": "x", "length": "short"})
    assert r.status_code == 200
    body = r.text
    assert '"type": "error"' in body
    assert '"phase": "internal"' in body


# ---------------------------------------------------------------------------
# GET /api/podcast/{arxiv_id}/{length}.mp3
# ---------------------------------------------------------------------------


def _make_podcast_dir(base: Path, arxiv_id: str, length: str) -> Path:
    d = base / "podcasts" / arxiv_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def test_get_mp3_returns_file(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    d = _make_podcast_dir(tmp_path, "abc", "short")
    (d / "short.mp3").write_bytes(b"FAKE_MP3")

    r = client.get("/api/podcast/abc/short.mp3")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == b"FAKE_MP3"


def test_get_mp3_supports_range(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    d = _make_podcast_dir(tmp_path, "abc", "short")
    data = bytes(range(100))
    (d / "short.mp3").write_bytes(data)

    r = client.get("/api/podcast/abc/short.mp3", headers={"Range": "bytes=10-29"})
    assert r.status_code == 206
    assert r.content == data[10:30]
    assert r.headers["content-range"] == "bytes 10-29/100"


def test_get_mp3_404_when_missing(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    r = client.get("/api/podcast/abc/short.mp3")
    assert r.status_code == 404


def test_get_mp3_400_on_invalid_length(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    r = client.get("/api/podcast/abc/huge.mp3")
    assert r.status_code == 400


def test_get_mp3_400_on_path_traversal(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    # Literal ".." reaches the route handler intact — our validator returns 400.
    # (URL-encoded %2F variants are caught earlier by Starlette's router with 404,
    # which is also blocking; we only have to guarantee the handler refuses what
    # does reach it.)
    r = client.get("/api/podcast/.../short.mp3")
    assert r.status_code == 400


def test_get_mp3_inline_disposition(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    base = tmp_path / "podcasts" / "abc"
    base.mkdir(parents=True)
    (base / "short.mp3").write_bytes(b"FAKE")

    r = client.get("/api/podcast/abc/short.mp3")
    assert r.status_code == 200
    # `inline` so <audio> can stream in-page; `attachment` would prompt save.
    assert r.headers["content-disposition"].startswith("inline")


# ---------------------------------------------------------------------------
# GET /api/podcast/{arxiv_id}/{length}.json
# ---------------------------------------------------------------------------


def test_get_json_returns_manifest(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    d = _make_podcast_dir(tmp_path, "abc", "short")
    # Both files must exist for cached_manifest() to return a value.
    (d / "short.mp3").write_bytes(b"FAKE")
    manifest = {"arxiv_id": "abc", "length": "short", "segments": [], "duration_s": 0}
    (d / "short.json").write_text(json.dumps(manifest))

    r = client.get("/api/podcast/abc/short.json")
    assert r.status_code == 200
    assert r.json() == manifest


def test_get_json_404_when_missing(client: TestClient, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    r = client.get("/api/podcast/abc/short.json")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /api/podcast/{arxiv_id}/{length}
# ---------------------------------------------------------------------------


def test_delete_invalidates_and_returns_status(
    client: TestClient, tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    d = _make_podcast_dir(tmp_path, "abc", "short")
    manifest = {"arxiv_id": "abc", "length": "short", "segments": [], "duration_s": 0}
    (d / "short.mp3").write_bytes(b"FAKE")
    (d / "short.json").write_text(json.dumps(manifest))

    r = client.delete("/api/podcast/abc/short")
    assert r.status_code == 200
    assert r.json() == {"removed": True}

    # Verify cache is gone.
    r2 = client.get("/api/podcast/abc/short.json")
    assert r2.status_code == 404


def test_delete_returns_false_when_no_cache(
    client: TestClient, tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))

    r = client.delete("/api/podcast/abc/short")
    assert r.status_code == 200
    assert r.json() == {"removed": False}
