from unittest.mock import patch, MagicMock

from app import health


def test_claude_available_returns_true_when_version_succeeds():
    fake = MagicMock(returncode=0, stdout="claude-code 1.2.3\n")
    with patch("app.health.subprocess.run", return_value=fake):
        assert health.claude_available() is True


def test_claude_available_returns_false_when_command_missing():
    with patch("app.health.subprocess.run", side_effect=FileNotFoundError):
        assert health.claude_available() is False


def test_claude_available_returns_false_when_nonzero_exit():
    fake = MagicMock(returncode=1, stdout="", stderr="error")
    with patch("app.health.subprocess.run", return_value=fake):
        assert health.claude_available() is False
