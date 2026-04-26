"""Tests for /api/models (codex model discovery) and /api/health codex gating.

The codex backend is gated on:
1. The codex CLI binary working (existing probe).
2. The presence of `~/.codex/models_cache.json` — without it, no model list
   to populate the picker, so codex is reported unavailable.

`/api/models?backend=codex` reads the cache, filters `visibility=="list"`,
sorts by `priority` ascending, and returns `[{slug, label, description}]`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import ai_backend
from app.main import app


# ---------- fixtures ----------

@pytest.fixture
def fake_codex_home(tmp_path, monkeypatch) -> Path:
    """Redirect Path.home() so the endpoint reads our temp cache, not the real one."""
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    return codex_dir


@pytest.fixture
def client():
    return TestClient(app)


def _write_cache(codex_dir: Path, models: list[dict]) -> None:
    (codex_dir / "models_cache.json").write_text(json.dumps({
        "fetched_at": "2026-04-25T00:00:00Z",
        "client_version": "0.124.0",
        "models": models,
    }))


# ---------- /api/models?backend=codex ----------

def test_models_endpoint_returns_sorted_filtered_list(client, fake_codex_home):
    _write_cache(fake_codex_home, [
        {"slug": "gpt-5.5", "display_name": "GPT-5.5", "description": "frontier",
         "visibility": "list", "priority": 0},
        {"slug": "gpt-5.4-mini", "display_name": "GPT-5.4 mini", "description": "cheap",
         "visibility": "list", "priority": 5},
        {"slug": "gpt-5.4", "display_name": "GPT-5.4", "description": "current",
         "visibility": "list", "priority": 1},
    ])

    r = client.get("/api/models?backend=codex")
    assert r.status_code == 200
    data = r.json()
    assert data["models"] == [
        {"slug": "gpt-5.5", "label": "GPT-5.5", "description": "frontier"},
        {"slug": "gpt-5.4", "label": "GPT-5.4", "description": "current"},
        {"slug": "gpt-5.4-mini", "label": "GPT-5.4 mini", "description": "cheap"},
    ]


def test_models_endpoint_filters_hidden_models(client, fake_codex_home):
    _write_cache(fake_codex_home, [
        {"slug": "gpt-5.5", "display_name": "GPT-5.5", "description": "x",
         "visibility": "list", "priority": 0},
        {"slug": "internal-only", "display_name": "Internal", "description": "x",
         "visibility": "hidden", "priority": 0},
    ])

    r = client.get("/api/models?backend=codex")
    assert r.status_code == 200
    slugs = [m["slug"] for m in r.json()["models"]]
    assert slugs == ["gpt-5.5"]


def test_models_endpoint_missing_cache_returns_503(client, fake_codex_home):
    # No cache file written.
    r = client.get("/api/models?backend=codex")
    assert r.status_code == 503
    assert "codex models cache" in r.json()["detail"].lower()


def test_models_endpoint_malformed_cache_returns_500(client, fake_codex_home):
    (fake_codex_home / "models_cache.json").write_text("{not json")
    r = client.get("/api/models?backend=codex")
    assert r.status_code == 500
    assert "unreadable" in r.json()["detail"].lower()


def test_models_endpoint_unknown_backend_is_400(client, fake_codex_home):
    r = client.get("/api/models?backend=claude")
    assert r.status_code == 400


def test_models_endpoint_priority_ties_broken_by_slug(client, fake_codex_home):
    _write_cache(fake_codex_home, [
        {"slug": "z-model", "display_name": "Z", "description": "x",
         "visibility": "list", "priority": 0},
        {"slug": "a-model", "display_name": "A", "description": "x",
         "visibility": "list", "priority": 0},
    ])
    r = client.get("/api/models?backend=codex")
    slugs = [m["slug"] for m in r.json()["models"]]
    assert slugs == ["a-model", "z-model"]


# ---------- /api/health codex gating ----------

async def test_codex_unavailable_when_cache_missing(monkeypatch, fake_codex_home):
    """Even when the codex binary works, missing cache ⇒ codex reported unavailable."""
    # Force proxy-mode off so we hit the host-side checks.
    monkeypatch.delenv("ATLAS_AI_PROXY", raising=False)

    async def _ok(_cmd):
        return True

    monkeypatch.setattr(ai_backend, "_local_cli_ok", _ok)

    out = await ai_backend.available_backends()
    assert out["codex"] is False  # no cache ⇒ unavailable


async def test_codex_available_when_cache_present(monkeypatch, fake_codex_home):
    monkeypatch.delenv("ATLAS_AI_PROXY", raising=False)
    _write_cache(fake_codex_home, [
        {"slug": "gpt-5.5", "display_name": "GPT-5.5", "description": "x",
         "visibility": "list", "priority": 0},
    ])

    async def _ok(_cmd):
        return True

    monkeypatch.setattr(ai_backend, "_local_cli_ok", _ok)

    out = await ai_backend.available_backends()
    assert out["codex"] is True


def test_models_endpoint_proxies_to_runner_in_docker_mode(client, monkeypatch):
    """In Docker mode the container can't read ~/.codex/. The backend proxies
    /api/models to the runner instead of reading the file directly."""
    monkeypatch.setenv("ATLAS_AI_PROXY", "http://host.docker.internal:8766")

    async def fake_via_runner():
        return [{"slug": "gpt-5.5", "label": "GPT-5.5", "description": "frontier"}]

    monkeypatch.setattr(ai_backend, "codex_models_via_runner", fake_via_runner)

    r = client.get("/api/models?backend=codex")
    assert r.status_code == 200
    assert r.json() == {"models": [{"slug": "gpt-5.5", "label": "GPT-5.5", "description": "frontier"}]}


def test_models_endpoint_proxy_mode_502_when_runner_unreachable(client, monkeypatch):
    monkeypatch.setenv("ATLAS_AI_PROXY", "http://host.docker.internal:8766")

    async def fake_via_runner():
        raise RuntimeError("no runner secret available")

    monkeypatch.setattr(ai_backend, "codex_models_via_runner", fake_via_runner)

    r = client.get("/api/models?backend=codex")
    assert r.status_code == 502


def test_models_endpoint_proxy_mode_passes_through_runner_503(client, monkeypatch):
    """If the runner says 503 (cache missing on host), the backend mirrors that
    status so the frontend sees the same shape it would in host mode."""
    import httpx

    monkeypatch.setenv("ATLAS_AI_PROXY", "http://host.docker.internal:8766")

    async def fake_via_runner():
        request = httpx.Request("GET", "http://x/models")
        response = httpx.Response(503, json={"detail": "codex models cache not found"}, request=request)
        raise httpx.HTTPStatusError("503", request=request, response=response)

    monkeypatch.setattr(ai_backend, "codex_models_via_runner", fake_via_runner)

    r = client.get("/api/models?backend=codex")
    assert r.status_code == 503
    assert "codex models cache not found" in r.json()["detail"]


async def test_default_codex_model_picks_top_priority_from_cache(monkeypatch, fake_codex_home):
    """The codex backend default for user-facing tasks tracks the cache's
    top-priority model, so a retired hardcoded slug never sneaks in."""
    monkeypatch.delenv("ATLAS_AI_PROXY", raising=False)
    _write_cache(fake_codex_home, [
        {"slug": "gpt-5.5", "display_name": "GPT-5.5", "description": "x",
         "visibility": "list", "priority": 0},
        {"slug": "gpt-5.4", "display_name": "GPT-5.4", "description": "x",
         "visibility": "list", "priority": 1},
        {"slug": "gpt-5.4-mini", "display_name": "GPT-5.4 mini", "description": "x",
         "visibility": "list", "priority": 5},
    ])

    assert await ai_backend.default_model("codex", "summarize") == "gpt-5.5"
    assert await ai_backend.default_model("codex", "ask") == "gpt-5.5"
    # rank/glossary get the cheapest tier (last by ascending priority).
    assert await ai_backend.default_model("codex", "rank") == "gpt-5.4-mini"
    assert await ai_backend.default_model("codex", "glossary") == "gpt-5.4-mini"


async def test_default_codex_model_falls_back_when_cache_missing(monkeypatch, fake_codex_home):
    monkeypatch.delenv("ATLAS_AI_PROXY", raising=False)
    # No cache file written.
    assert await ai_backend.default_model("codex", "summarize") == ai_backend._CODEX_FALLBACK


async def test_default_claude_model_uses_aliases(monkeypatch):
    # Claude doesn't depend on the codex cache at all.
    assert await ai_backend.default_model("claude", "summarize") == "opus"
    assert await ai_backend.default_model("claude", "ask") == "sonnet"
    assert await ai_backend.default_model("claude", "glossary") == "sonnet"


async def test_codex_unavailable_when_binary_missing_even_with_cache(monkeypatch, fake_codex_home):
    monkeypatch.delenv("ATLAS_AI_PROXY", raising=False)
    _write_cache(fake_codex_home, [
        {"slug": "gpt-5.5", "display_name": "GPT-5.5", "description": "x",
         "visibility": "list", "priority": 0},
    ])

    async def _probe(cmd):
        return cmd != "codex"   # claude works, codex doesn't

    monkeypatch.setattr(ai_backend, "_local_cli_ok", _probe)

    out = await ai_backend.available_backends()
    assert out["codex"] is False
    assert out["claude"] is True
