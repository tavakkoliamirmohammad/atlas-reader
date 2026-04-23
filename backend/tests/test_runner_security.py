"""Security tests for the Atlas AI runner.

Each test asserts one hardening property. These run without spawning real
subprocesses — subprocess_spawn.spawn is monkeypatched to a fake that records
argv and returns canned output.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import ai_argv, db, runner_main, secret_store, subprocess_spawn


# ---------- helpers ----------

TEST_SECRET = "s" * 43   # any stable value; bearer compared with compare_digest


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Point ATLAS_DATA_DIR at a fresh temp dir for every test."""
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    (tmp_path / "pdfs").mkdir(exist_ok=True)
    # Seed the secret for all tests; individual tests override as needed.
    monkeypatch.setenv("ATLAS_AI_SECRET", TEST_SECRET)
    yield


@pytest.fixture
def client():
    return TestClient(runner_main.app)


def _auth() -> dict[str, str]:
    # TestClient defaults Host to "testserver" which is blocked by design;
    # every test below wants to pass the host check, so force a loopback Host.
    return {
        "Authorization": f"Bearer {TEST_SECRET}",
        "Host": "127.0.0.1",
    }


def _valid_payload(**overrides: Any) -> dict:
    base = {
        "backend": "codex",
        "task": "summarize",
        "model": "gpt-5.4",
        "directive": "Produce the deep summary.",
        "prompt": "PAPER TEXT HERE",
    }
    base.update(overrides)
    return base


# ---------- host-header allowlist ----------

def test_host_header_allowlist_accepts_loopback(client, monkeypatch):
    monkeypatch.setattr(runner_main, "_run_job", _fake_run_job)
    r = client.post("/run", json=_valid_payload(), headers={**_auth(), "Host": "127.0.0.1"})
    assert r.status_code == 200


def test_host_header_allowlist_accepts_host_docker_internal(client, monkeypatch):
    monkeypatch.setattr(runner_main, "_run_job", _fake_run_job)
    r = client.post("/run", json=_valid_payload(), headers={**_auth(), "Host": "host.docker.internal"})
    assert r.status_code == 200


def test_host_header_rejects_dns_rebinding_host(client):
    r = client.post("/run", json=_valid_payload(), headers={**_auth(), "Host": "evil.attacker.com"})
    assert r.status_code == 421


# ---------- bearer-token auth ----------

def test_missing_auth_header_is_401(client):
    r = client.post("/run", json=_valid_payload(), headers={"Host": "127.0.0.1"})
    assert r.status_code == 401


def test_bad_token_is_401(client):
    r = client.post(
        "/run", json=_valid_payload(),
        headers={"Host": "127.0.0.1", "Authorization": "Bearer wrongtoken"},
    )
    assert r.status_code == 401


def test_missing_secret_returns_503(client, monkeypatch):
    monkeypatch.delenv("ATLAS_AI_SECRET", raising=False)
    monkeypatch.setattr(secret_store, "load", lambda: None)
    r = client.post("/run", json=_valid_payload(), headers=_auth())
    assert r.status_code == 503


# ---------- payload validation ----------

def test_unknown_backend_is_422(client):
    r = client.post("/run", json=_valid_payload(backend="gemini"), headers=_auth())
    assert r.status_code == 422


def test_unknown_task_is_422(client):
    r = client.post("/run", json=_valid_payload(task="exfiltrate"), headers=_auth())
    assert r.status_code == 422


def test_off_allowlist_model_is_400(client):
    r = client.post("/run", json=_valid_payload(backend="codex", model="gpt-9"), headers=_auth())
    assert r.status_code == 400


def test_claude_model_on_codex_backend_is_400(client):
    # Guards against cross-backend model confusion.
    r = client.post("/run", json=_valid_payload(backend="codex", model="opus"), headers=_auth())
    assert r.status_code == 400


def test_directive_starting_with_dash_is_422(client):
    r = client.post("/run", json=_valid_payload(directive="--do-bad-things"), headers=_auth())
    assert r.status_code == 422


def test_directive_too_long_is_422(client):
    r = client.post("/run", json=_valid_payload(directive="x" * 10_000), headers=_auth())
    assert r.status_code == 422


def test_oversized_prompt_is_422(client):
    big = "x" * (runner_main.MAX_PROMPT_BYTES + 1)
    r = client.post("/run", json=_valid_payload(prompt=big), headers=_auth())
    assert r.status_code == 422


def test_read_path_traversal_is_422(client, tmp_path):
    r = client.post(
        "/run",
        json=_valid_payload(enable_read_file=str(tmp_path / ".." / "etc" / "passwd")),
        headers=_auth(),
    )
    assert r.status_code == 422


def test_read_path_outside_data_dir_is_422(client):
    # /etc/passwd is absolute, no "..", but outside ATLAS_DATA_DIR.
    r = client.post("/run", json=_valid_payload(enable_read_file="/etc/passwd"), headers=_auth())
    assert r.status_code == 422


def test_read_path_inside_data_dir_is_accepted(client, tmp_path, monkeypatch):
    monkeypatch.setattr(runner_main, "_run_job", _fake_run_job)
    pdf = tmp_path / "pdfs" / "2401.12345.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    r = client.post(
        "/run",
        json=_valid_payload(enable_read_file=str(pdf)),
        headers=_auth(),
    )
    assert r.status_code == 200


# ---------- argv snapshots (hardening invariants) ----------

def test_codex_argv_always_has_read_only_sandbox():
    argv = ai_argv.build_argv(
        backend="codex", task="summarize", model="gpt-5.4",
        directive="Do it.", enable_read_file=False,
    )
    assert "--sandbox" in argv
    assert argv[argv.index("--sandbox") + 1] == "read-only"
    assert 'sandbox_mode="read-only"' in argv


def test_codex_argv_rejects_leading_dash_directive():
    with pytest.raises(ValueError):
        ai_argv.build_argv(
            backend="codex", task="summarize", model="gpt-5.4",
            directive="--exec rm -rf /", enable_read_file=False,
        )


def test_codex_argv_uses_double_dash_before_directive():
    argv = ai_argv.build_argv(
        backend="codex", task="summarize", model="gpt-5.4",
        directive="Produce summary.", enable_read_file=False,
    )
    assert "--" in argv
    assert argv[-1] == "Produce summary."
    assert argv[argv.index("--") + 1] == "Produce summary."


def test_claude_argv_restricts_to_read_tool_when_requested():
    argv = ai_argv.build_argv(
        backend="claude", task="summarize", model="opus",
        directive="Summarize.", enable_read_file=True,
    )
    assert "--allowedTools" in argv
    assert argv[argv.index("--allowedTools") + 1] == "Read"


def test_claude_argv_has_no_tools_when_read_disabled():
    argv = ai_argv.build_argv(
        backend="claude", task="rank", model="haiku",
        directive="Score.", enable_read_file=False,
    )
    assert "--allowedTools" not in argv


def test_claude_off_allowlist_model_rejected():
    with pytest.raises(ValueError):
        ai_argv.build_argv(
            backend="claude", task="ask", model="evil-model",
            directive="Answer.", enable_read_file=False,
        )


# ---------- rate limiter ----------

def test_rate_limiter_rejects_after_capacity(monkeypatch):
    # Exercise the limiter directly without the full request cycle.
    async def exhaust():
        lim = runner_main._RateLimiter(per_minute=2)
        assert await lim.allow() is True
        assert await lim.allow() is True
        assert await lim.allow() is False

    asyncio.run(exhaust())


def test_over_rate_limit_returns_429(client, monkeypatch):
    monkeypatch.setattr(runner_main, "_run_job", _fake_run_job)
    # Drain the bucket to zero, then next request must 429.
    drained = runner_main._RateLimiter(per_minute=1)
    drained.tokens = 0.0
    monkeypatch.setattr(runner_main, "_rate", drained)
    r = client.post("/run", json=_valid_payload(), headers=_auth())
    assert r.status_code == 429


# ---------- fake job runner used by accepting paths above ----------

async def _fake_run_job(body, timeout_s):   # noqa: ARG001 - signature-matched fake
    yield {"type": "text", "text": "hello"}


def test_ensure_preserves_existing_runner_env_keys(atlas_data_dir, monkeypatch):
    """secret_store.ensure() must not clobber port keys written by port_config.persist_ports.

    Regression: previously ensure() did env.write_text('ATLAS_AI_SECRET=...') which
    destroyed ATLAS_PORT / ATLAS_RUNNER_PORT already in the file.
    """
    from app import secret_store

    env_file = atlas_data_dir / "runner.env"
    env_file.write_text("ATLAS_PORT=9000\nATLAS_RUNNER_PORT=9001\n")
    monkeypatch.delenv("ATLAS_AI_SECRET", raising=False)

    token = secret_store.ensure()
    content = env_file.read_text()

    assert "ATLAS_PORT=9000" in content
    assert "ATLAS_RUNNER_PORT=9001" in content
    assert f"ATLAS_AI_SECRET={token}" in content


def test_ensure_writes_runner_env_with_0o600_mode(atlas_data_dir, monkeypatch):
    """runner.env must never exist at a mode more permissive than 0o600.

    Regression: previously write_text then chmod created a brief window where
    the file holding ATLAS_AI_SECRET was world-readable.
    """
    import os
    from app import secret_store

    env_file = atlas_data_dir / "runner.env"
    monkeypatch.delenv("ATLAS_AI_SECRET", raising=False)
    secret_store.ensure()

    mode = os.stat(env_file).st_mode & 0o777
    assert mode == 0o600, f"runner.env mode {oct(mode)} leaks the secret"
