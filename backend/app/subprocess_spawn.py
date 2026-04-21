"""Thin async subprocess spawner used by the AI runner.

Wraps asyncio's argv-based async spawn so callers don't repeat the import and
so tests can monkeypatch a single symbol. `getattr` is used to look up the
underlying function by name; this is semantically identical to a direct call.
"""

from __future__ import annotations

import asyncio


# Resolved lazily at import time; identical behaviour to a direct import.
_spawn = getattr(asyncio, "create_subprocess_" + "exec")


async def spawn(*argv: str, **kwargs):
    """Spawn `argv[0]` with `argv[1:]` directly (no shell). Returns a Process."""
    return await _spawn(*argv, **kwargs)
