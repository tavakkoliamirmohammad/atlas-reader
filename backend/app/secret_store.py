"""Shared secret for the Atlas AI runner.

The secret lives at `~/.atlas/runner.secret` (mode 0600) and is injected into
both the runner and the backend at startup. It's also surfaced as
`~/.atlas/runner.env` (`ATLAS_AI_SECRET=<value>`) so docker-compose can pick it
up via `env_file:`.

Anything running as the user's UID can read this file; that's the inherent
ceiling of localhost-daemon security on macOS. The token still buys us
protection against DNS-rebinding drive-bys and accidental cross-process talk.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from app import db


def _secret_path() -> Path:
    return db.data_dir() / "runner.secret"


def _env_path() -> Path:
    return db.data_dir() / "runner.env"


def load() -> str | None:
    """Return the secret from env or disk, or None if missing."""
    if env := os.environ.get("ATLAS_AI_SECRET"):
        return env.strip() or None
    p = _secret_path()
    if p.exists():
        return p.read_text().strip() or None
    return None


def ensure() -> str:
    """Return the secret, generating + persisting a fresh one if missing."""
    if existing := load():
        return existing
    token = secrets.token_urlsafe(32)
    secret = _secret_path()
    env = _env_path()
    secret.write_text(token)
    os.chmod(secret, 0o600)
    env.write_text(f"ATLAS_AI_SECRET={token}\n")
    os.chmod(env, 0o600)
    return token
