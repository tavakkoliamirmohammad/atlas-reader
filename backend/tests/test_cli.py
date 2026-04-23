"""Tests for the Docker-only Atlas CLI.

Covers: argparse surface (new `up`/`down`, removed `start`/`stop`/`restart`),
--port / --runner-port flags, port persistence, conflict pre-check, status /
logs now shelling out to `docker compose`, doctor surfacing both ports.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app import cli, port_config


# ---------- argparse surface ----------

def test_old_native_commands_are_rejected(atlas_data_dir):
    for cmd in ("start", "stop", "restart"):
        with pytest.raises(SystemExit):
            cli.main([cmd])


def test_new_commands_parse(atlas_data_dir):
    # These parse; their handlers are patched below so we don't really run docker.
    with patch("app.cli._have_docker", return_value=False):
        assert cli.main(["up"]) != 0  # errors because docker missing
        assert cli.main(["down"]) == 0  # down is a no-op without docker


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
    with patch("app.cli._have_docker", return_value=True), \
         patch("app.cli._start_runner"), \
         patch("app.cli.port_config.is_port_free", side_effect=[True, False]):
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
