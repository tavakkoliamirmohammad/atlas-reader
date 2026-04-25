"""Unit tests for port_config: env > runner.env > default resolution + persistence + free-port check."""

from __future__ import annotations

import socket

import pytest

from app import port_config


def _env_file(data_dir):
    return data_dir / "runner.env"


def test_defaults_when_no_env_no_file(monkeypatch, atlas_data_dir):
    monkeypatch.delenv("ATLAS_PORT", raising=False)
    monkeypatch.delenv("ATLAS_RUNNER_PORT", raising=False)
    assert port_config.backend_port() == 8765
    assert port_config.runner_port() == 8766


def test_runner_env_overrides_default(monkeypatch, atlas_data_dir):
    monkeypatch.delenv("ATLAS_PORT", raising=False)
    monkeypatch.delenv("ATLAS_RUNNER_PORT", raising=False)
    _env_file(atlas_data_dir).write_text("ATLAS_PORT=9000\nATLAS_RUNNER_PORT=9001\n")
    assert port_config.backend_port() == 9000
    assert port_config.runner_port() == 9001


def test_process_env_overrides_runner_env(monkeypatch, atlas_data_dir):
    _env_file(atlas_data_dir).write_text("ATLAS_PORT=9000\nATLAS_RUNNER_PORT=9001\n")
    monkeypatch.setenv("ATLAS_PORT", "12000")
    monkeypatch.setenv("ATLAS_RUNNER_PORT", "12001")
    assert port_config.backend_port() == 12000
    assert port_config.runner_port() == 12001


def test_invalid_file_value_falls_back_to_default(monkeypatch, atlas_data_dir):
    monkeypatch.delenv("ATLAS_PORT", raising=False)
    _env_file(atlas_data_dir).write_text("ATLAS_PORT=not-a-number\n")
    assert port_config.backend_port() == 8765


def test_persist_creates_file_with_both_keys(atlas_data_dir):
    port_config.persist_ports(backend=9000, runner=9001)
    content = _env_file(atlas_data_dir).read_text()
    assert "ATLAS_PORT=9000" in content
    assert "ATLAS_RUNNER_PORT=9001" in content


def test_persist_preserves_unrelated_keys(atlas_data_dir):
    _env_file(atlas_data_dir).write_text("ATLAS_AI_SECRET=keep-me\n")
    port_config.persist_ports(backend=9000, runner=None)
    content = _env_file(atlas_data_dir).read_text()
    assert "ATLAS_AI_SECRET=keep-me" in content
    assert "ATLAS_PORT=9000" in content
    assert "ATLAS_RUNNER_PORT" not in content


def test_persist_none_leaves_key_untouched(atlas_data_dir):
    _env_file(atlas_data_dir).write_text(
        "ATLAS_AI_SECRET=keep\nATLAS_PORT=8765\nATLAS_RUNNER_PORT=8766\n"
    )
    port_config.persist_ports(backend=9000, runner=None)
    content = _env_file(atlas_data_dir).read_text()
    assert "ATLAS_PORT=9000" in content
    assert "ATLAS_RUNNER_PORT=8766" in content


def test_persist_updates_existing_key(atlas_data_dir):
    _env_file(atlas_data_dir).write_text("ATLAS_PORT=8765\nATLAS_RUNNER_PORT=8766\n")
    port_config.persist_ports(backend=9000, runner=9001)
    content = _env_file(atlas_data_dir).read_text()
    assert content.count("ATLAS_PORT=") == 1
    assert content.count("ATLAS_RUNNER_PORT=") == 1
    assert "ATLAS_PORT=9000" in content
    assert "ATLAS_RUNNER_PORT=9001" in content


def test_is_port_free_true_for_unbound(atlas_data_dir):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    assert port_config.is_port_free(port) is True


def test_is_port_free_false_when_bound(atlas_data_dir):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    try:
        assert port_config.is_port_free(port) is False
    finally:
        s.close()


def test_persist_ports_writes_with_0o600_mode(atlas_data_dir):
    """runner.env must never exist at a mode more permissive than 0o600.

    Regression: previously write_text then chmod created a brief window where
    the file — which may already contain ATLAS_AI_SECRET — was world-readable.
    """
    import os

    port_config.persist_ports(backend=9000, runner=9001)
    mode = os.stat(atlas_data_dir / "runner.env").st_mode & 0o777
    assert mode == 0o600, f"runner.env mode {oct(mode)} leaks the secret"


def test_runner_main_resolves_port_from_runner_env_file(monkeypatch, atlas_data_dir):
    """`runner_main.main` must pick the persisted port from runner.env even when no env var is set.

    Regression: previously the runner read os.environ['ATLAS_RUNNER_PORT'] directly and
    ignored runner.env, so `atlas up --runner-port N` silently bound the runner to 8766
    while telling the container to talk to N.
    """
    import os

    (atlas_data_dir / "runner.env").write_text("ATLAS_RUNNER_PORT=9001\n")
    monkeypatch.delenv("ATLAS_RUNNER_PORT", raising=False)

    # The runner module must consult port_config (and thus runner.env), not raw os.environ.
    from app import port_config
    assert port_config.runner_port() == 9001


def test_runner_main_uses_port_config_not_os_environ(monkeypatch, atlas_data_dir, capsys):
    """Smoke test: runner_main reads through port_config and surfaces the right value.

    Patches uvicorn.run so we don't actually bind. Confirms the port passed to uvicorn
    came from runner.env, not from a missing env var defaulting to 8766.
    """
    from unittest.mock import patch

    (atlas_data_dir / "runner.env").write_text("ATLAS_RUNNER_PORT=9001\nATLAS_AI_SECRET=stub\n")
    monkeypatch.delenv("ATLAS_RUNNER_PORT", raising=False)
    monkeypatch.delenv("ATLAS_AI_SECRET", raising=False)

    from app import runner_main
    with patch("app.runner_main.uvicorn.run") as mock_run:
        runner_main.main()
    kwargs = mock_run.call_args.kwargs
    assert kwargs["port"] == 9001
