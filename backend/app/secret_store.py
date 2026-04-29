"""Shared secret for the Atlas AI runner.

The secret lives at `~/.atlas/runner.secret` (mode 0600) and is injected into
both the runner and the backend at startup. It's also written to
`~/.atlas/runner.env` (`ATLAS_AI_SECRET=<value>`) which docker-compose reads
via `env_file:`.

That same ``runner.env`` file is shared with ``app.port_config``: when the
user passes ``atlas up --port`` / ``--runner-port``, those port overrides
land in ``runner.env`` as ``ATLAS_PORT`` / ``ATLAS_RUNNER_PORT`` keys. Writes
here MUST preserve every key owned by another module — earlier versions of
``ensure()`` clobbered the file with just ``ATLAS_AI_SECRET=...``, silently
destroying the persisted port values.

Anything running as the user's UID can read this file; that's the inherent
ceiling of localhost-daemon security on macOS. The token still buys us
protection against DNS-rebinding drive-bys and accidental cross-process talk.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from app import db, port_config
from app.fs_util import atomic_write_0o600


def _secret_path() -> Path:
    return db.data_dir() / "runner.secret"


def _env_path() -> Path:
    return db.data_dir() / "runner.env"


def load() -> str | None:
    """Return the secret from env, runner.secret, or runner.env; None if missing."""
    if env := os.environ.get("ATLAS_AI_SECRET"):
        return env.strip() or None
    p = _secret_path()
    if p.exists():
        return p.read_text().strip() or None
    val = port_config.read_env_file().get("ATLAS_AI_SECRET")
    return val.strip() or None if val else None


def ensure() -> str:
    """Return the secret, generating + persisting a fresh one if missing.

    Preserves any existing keys in ``runner.env`` (e.g. ``ATLAS_PORT``,
    ``ATLAS_RUNNER_PORT`` written by ``port_config.persist_ports``); only
    the ``ATLAS_AI_SECRET`` key is inserted / updated.
    """
    if existing := load():
        return existing
    token = secrets.token_urlsafe(32)

    # runner.secret: atomic-permissioned write.
    atomic_write_0o600(_secret_path(), token)

    # runner.env: preserve other keys, upsert ATLAS_AI_SECRET, atomic write.
    pairs = port_config.read_env_file()
    pairs["ATLAS_AI_SECRET"] = token
    body = "".join(f"{k}={v}\n" for k, v in pairs.items())
    atomic_write_0o600(_env_path(), body)

    return token
