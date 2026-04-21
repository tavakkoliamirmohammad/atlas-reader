"""Detect whether the local AI backend CLIs are available.

Used by sync code paths (e.g. `digest.build_today` gating the ranker call).
The async API-facing probe lives in `ai_backend.available_backends`, which
also handles the Docker-proxy case.
"""

from __future__ import annotations

import subprocess


def _probe(cmd: str) -> bool:
    try:
        result = subprocess.run(
            [cmd, "--version"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def claude_available() -> bool:
    return _probe("claude")


def codex_available() -> bool:
    return _probe("codex")


def backend_available(backend: str) -> bool:
    if backend == "claude":
        return claude_available()
    if backend == "codex":
        return codex_available()
    return False
