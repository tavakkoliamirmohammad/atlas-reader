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
