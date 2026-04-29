"""Tests for the Docker-only Atlas CLI.

Covers: argparse surface (new `up`/`down`/`restart`, removed `start`/`stop`),
--port / --runner-port flags, port persistence, conflict pre-check, status /
logs now shelling out to `docker compose`, doctor surfacing both ports.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app import cli, port_config


# ---------- argparse surface ----------

def test_old_native_commands_are_rejected(atlas_data_dir):
    for cmd in ("start", "stop"):
        with pytest.raises(SystemExit):
            cli.main([cmd])


def test_new_commands_parse(atlas_data_dir):
    # These parse; their handlers are patched below so we don't really run docker.
    with patch("app.cli._have_docker", return_value=False):
        assert cli.main(["up"]) != 0  # errors because docker missing
        assert cli.main(["down"]) == 0  # down is a no-op without docker


def test_restart_calls_down_then_up(atlas_data_dir):
    """`atlas restart` must stop everything before starting it back up,
    forwarding any port flags it received."""
    call_order: list[str] = []

    def fake_down(args):
        call_order.append("down")
        return 0

    def fake_up(args):
        call_order.append("up")
        # Verify the flags propagated through.
        assert args.port == 9000
        assert args.runner_port == 9001
        return 0

    with patch("app.cli.cmd_down", side_effect=fake_down) as mock_down, \
         patch("app.cli.cmd_up", side_effect=fake_up) as mock_up:
        rc = cli.main(["restart", "--port", "9000", "--runner-port", "9001"])

    assert rc == 0
    assert call_order == ["down", "up"]
    assert mock_down.call_count == 1
    assert mock_up.call_count == 1


def test_runner_commands_still_exist(atlas_data_dir):
    with patch("app.cli._start_runner") as mock_start, \
         patch("app.cli._stop_runner") as mock_stop:
        assert cli.main(["start-runner"]) == 0
        assert cli.main(["stop-runner"]) == 0
    mock_start.assert_called_once()
    mock_stop.assert_called_once()


# ---------- port flags ----------

def test_up_persists_ports_from_flags(atlas_data_dir):
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli._start_runner"), \
         patch("app.cli.port_config.is_port_free", return_value=True), \
         patch("app.cli.subprocess.run") as mock_run, \
         patch("app.cli._wait_for_health", return_value=False):
        mock_run.return_value = MagicMock(returncode=0)
        cli.main(["up", "--port", "9000", "--runner-port", "9001"])
    env_file = atlas_data_dir / "runner.env"
    content = env_file.read_text()
    assert "ATLAS_PORT=9000" in content
    assert "ATLAS_RUNNER_PORT=9001" in content


def test_up_without_flags_does_not_overwrite_existing_ports(atlas_data_dir):
    (atlas_data_dir / "runner.env").write_text(
        "ATLAS_AI_SECRET=abc\nATLAS_PORT=9000\nATLAS_RUNNER_PORT=9001\n"
    )
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli._start_runner"), \
         patch("app.cli.port_config.is_port_free", return_value=True), \
         patch("app.cli.subprocess.run") as mock_run, \
         patch("app.cli._wait_for_health", return_value=False):
        mock_run.return_value = MagicMock(returncode=0)
        cli.main(["up"])
    content = (atlas_data_dir / "runner.env").read_text()
    assert "ATLAS_PORT=9000" in content
    assert "ATLAS_RUNNER_PORT=9001" in content


# ---------- conflict pre-check ----------

def test_up_exits_with_error_when_backend_port_in_use(capsys, atlas_data_dir):
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli._start_runner"), \
         patch("app.cli.port_config.is_port_free", side_effect=[False, True]):
        rc = cli.main(["up"])
    assert rc != 0
    err = capsys.readouterr().err
    assert "port" in err.lower()
    assert "--port" in err or "ATLAS_PORT" in err


def test_up_exits_with_error_when_runner_port_in_use(capsys, atlas_data_dir):
    # Backend port is free, runner port is busy. _find_runner_orphans returns
    # [] so the new sweep-then-retry path falls straight through to the
    # "still busy after sweep" error.
    def fake_is_port_free(port: int) -> bool:
        return port != 8766
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli._start_runner"), \
         patch("app.cli._find_runner_orphans", return_value=[]), \
         patch("app.cli.port_config.is_port_free", side_effect=fake_is_port_free):
        rc = cli.main(["up"])
    assert rc != 0
    err = capsys.readouterr().err
    assert "--runner-port" in err or "ATLAS_RUNNER_PORT" in err


# ---------- status ----------

def test_status_shells_out_to_docker_compose_ps(capsys, atlas_data_dir):
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="NAME    STATUS\natlas   running\n",
            stderr="",
        )
        cli.main(["status"])
    assert any(
        "docker" in " ".join(call.args[0]) and "ps" in call.args[0]
        for call in mock_run.call_args_list
    )
    out = capsys.readouterr().out
    assert "atlas" in out


def test_status_reports_current_backend_port(capsys, atlas_data_dir):
    (atlas_data_dir / "runner.env").write_text("ATLAS_PORT=9000\n")
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
        cli.main(["status"])
    out = capsys.readouterr().out
    assert "9000" in out


# ---------- logs ----------

def test_logs_wraps_docker_compose_logs(atlas_data_dir):
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        cli.main(["logs"])
    args = mock_run.call_args.args[0]
    assert "docker" in args[0]
    assert "logs" in args
    assert "atlas" in args


# ---------- doctor ----------

def test_doctor_prints_both_ports(capsys, atlas_data_dir):
    (atlas_data_dir / "runner.env").write_text(
        "ATLAS_PORT=9000\nATLAS_RUNNER_PORT=9001\n"
    )
    with patch("app.cli.secret_store.load", return_value=None):
        cli.main(["doctor"])
    out = capsys.readouterr().out
    assert "9000" in out
    assert "9001" in out


# ---------- launchd wrappers ----------

def test_install_launchd_calls_launchd_install(capsys, atlas_data_dir):
    with patch("app.cli.launchd.install", return_value="installed: /tmp/foo.plist"):
        cli.main(["install-launchd"])
    assert "installed" in capsys.readouterr().out


def test_uninstall_launchd_calls_launchd_uninstall(capsys, atlas_data_dir):
    with patch("app.cli.launchd.uninstall", return_value="removed: /tmp/foo.plist"):
        cli.main(["uninstall-launchd"])
    assert "removed" in capsys.readouterr().out


def test_up_skips_runner_port_check_when_our_runner_already_alive(atlas_data_dir):
    """When our own runner PID is alive on the runner port, atlas up must NOT
    reject as 'port in use' — _start_runner() handles already-alive idempotently.
    Regression: a leftover runner from a prior session would reject every
    subsequent `atlas up`.
    """
    from unittest.mock import MagicMock, patch
    # Pretend our runner is alive (PID file present, _is_alive returns True).
    pid_file = atlas_data_dir / "atlas-runner.pid"
    pid_file.write_text("12345")

    # is_port_free returns True for backend, would return False for runner —
    # but we expect the runner check to be SKIPPED, so this False should never matter.
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli._is_alive", return_value=True), \
         patch("app.cli._start_runner"), \
         patch("app.cli.port_config.is_port_free", side_effect=[True, False]) as mock_free, \
         patch("app.cli.subprocess.run") as mock_run, \
         patch("app.cli._wait_for_health", return_value=False):
        mock_run.return_value = MagicMock(returncode=0)
        rc = cli.main(["up"])

    # cmd_up should have proceeded past the pre-checks (it returns 1 only because
    # we mock health to fail; that's a separate downstream path).
    # Critically, is_port_free was called at most once (for the backend) — never
    # for the runner.
    assert mock_free.call_count == 1, (
        f"runner pre-check should be skipped when our runner is alive; "
        f"got {mock_free.call_count} is_port_free calls"
    )
    # And docker compose was actually invoked, proving we passed the pre-checks.
    assert any("up" in c.args[0] and "--build" in c.args[0]
               for c in mock_run.call_args_list)


def test_up_flag_overrides_existing_env_var(atlas_data_dir, monkeypatch):
    """`--port N` must win over a stale `ATLAS_PORT` exported in the shell.

    Regression: the explicit flag should always beat ambient env, otherwise the user
    can be surprised when `--port 9000` is silently ignored because they had
    ATLAS_PORT=8765 exported.
    """
    monkeypatch.setenv("ATLAS_PORT", "8765")
    from unittest.mock import MagicMock, patch

    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli._start_runner"), \
         patch("app.cli.port_config.is_port_free", return_value=True), \
         patch("app.cli.subprocess.run") as mock_run, \
         patch("app.cli._wait_for_health", return_value=False):
        mock_run.return_value = MagicMock(returncode=0)
        cli.main(["up", "--port", "9000"])

    # Look at the env passed to the docker compose subprocess call (the one with up/--build/-d).
    compose_call = next(
        c for c in mock_run.call_args_list
        if "up" in c.args[0] and "--build" in c.args[0]
    )
    assert compose_call.kwargs["env"]["ATLAS_PORT"] == "9000"
