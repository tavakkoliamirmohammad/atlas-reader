"""Port resolution and persistence for Atlas.

Two ports are user-visible and can collide with other apps on the host:

- ``ATLAS_PORT`` (default 8765) — the backend HTTP port published from the
  container to the host.
- ``ATLAS_RUNNER_PORT`` (default 8766) — the AI runner, which always lives on
  the host; the container reaches it via ``host.docker.internal:<port>``.

Resolution order for each port, highest-priority first:

1. the process environment (``os.environ``)
2. ``~/.atlas/runner.env`` (written by ``atlas up --port ...``)
3. the built-in default

The runner.env file is shared with ``secret_store``: it already holds
``ATLAS_AI_SECRET`` and is loaded by ``docker-compose.yml`` via ``env_file:``.
Writes here MUST preserve every key we don't own.
"""

from __future__ import annotations

import os
import socket
from pathlib import Path

from app import db
from app.fs_util import atomic_write_0o600

DEFAULT_BACKEND_PORT = 8765
DEFAULT_RUNNER_PORT = 8766


def _env_file() -> Path:
    return db.data_dir() / "runner.env"


def read_env_file() -> dict[str, str]:
    """Return the key=value pairs in runner.env (empty dict if missing/unreadable)."""
    p = _env_file()
    if not p.exists():
        return {}
    pairs: dict[str, str] = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        pairs[k.strip()] = v.strip()
    return pairs


def _resolve(key: str, default: int) -> int:
    """Read ``key`` from os.environ, then runner.env, then fall back to ``default``."""
    for source in (os.environ.get(key), read_env_file().get(key)):
        if source is None or source == "":
            continue
        try:
            return int(source)
        except ValueError:
            continue
    return default


def backend_port() -> int:
    return _resolve("ATLAS_PORT", DEFAULT_BACKEND_PORT)


def runner_port() -> int:
    return _resolve("ATLAS_RUNNER_PORT", DEFAULT_RUNNER_PORT)


def persist_ports(*, backend: int | None, runner: int | None) -> None:
    """Write ATLAS_PORT / ATLAS_RUNNER_PORT to runner.env, preserving other keys.

    A ``None`` argument means "leave that key as-is in the file"; it does not
    clear it.
    """
    path = _env_file()
    existing = read_env_file()
    if backend is not None:
        existing["ATLAS_PORT"] = str(backend)
    if runner is not None:
        existing["ATLAS_RUNNER_PORT"] = str(runner)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(f"{k}={v}\n" for k, v in existing.items())
    atomic_write_0o600(path, body)


def is_port_free(port: int, host: str = "127.0.0.1") -> bool:
    """Return True iff no process is currently bound to (host, port)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
    except OSError:
        return False
    finally:
        s.close()
    return True
