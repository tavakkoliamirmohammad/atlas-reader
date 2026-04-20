"""Detect whether the local `claude` CLI is available for AI calls."""

from __future__ import annotations

import subprocess


def claude_available() -> bool:
    """Return True if `claude --version` exits 0 within a few seconds."""
    try:
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
