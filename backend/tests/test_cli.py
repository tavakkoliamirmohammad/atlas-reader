from unittest.mock import patch

from app import cli


def test_status_command_when_running(capsys, atlas_data_dir):
    pid_file = atlas_data_dir / "atlas.pid"
    pid_file.write_text("12345")
    with patch("app.cli._is_alive", return_value=True):
        cli.main(["status"])
    captured = capsys.readouterr()
    assert "running" in captured.out
    assert "12345" in captured.out


def test_status_command_when_not_running(capsys, atlas_data_dir):
    cli.main(["status"])
    captured = capsys.readouterr()
    assert "not running" in captured.out


def test_start_writes_pid_file(atlas_data_dir):
    with patch("app.cli.subprocess.Popen") as MockPopen:
        MockPopen.return_value.pid = 99999
        cli.main(["start"])
    pid_file = atlas_data_dir / "atlas.pid"
    assert pid_file.exists()
    assert pid_file.read_text().strip() == "99999"


def test_stop_removes_pid_file(atlas_data_dir):
    pid_file = atlas_data_dir / "atlas.pid"
    pid_file.write_text("12345")
    with patch("app.cli.os.kill") as MockKill:
        cli.main(["stop"])
    assert not pid_file.exists()
    MockKill.assert_called_once()


def test_install_launchd_calls_launchd_install(capsys, atlas_data_dir):
    with patch("app.cli.launchd.install", return_value="installed: /tmp/foo.plist"):
        cli.main(["install-launchd"])
    assert "installed" in capsys.readouterr().out


def test_uninstall_launchd_calls_launchd_uninstall(capsys, atlas_data_dir):
    with patch("app.cli.launchd.uninstall", return_value="removed: /tmp/foo.plist"):
        cli.main(["uninstall-launchd"])
    assert "removed" in capsys.readouterr().out
