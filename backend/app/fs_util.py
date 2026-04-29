"""Tiny filesystem helpers shared by `port_config` and `secret_store`.

Kept as a leaf module (stdlib-only, no internal imports) so anything in the
backend can pull from it without risking an import cycle.
"""

from __future__ import annotations

import os
from pathlib import Path


def atomic_write_0o600(path: Path, content: str) -> None:
    """Write ``content`` to ``path`` atomically at mode 0o600 with no
    intermediate window at a laxer mode.

    ``write_text(...)`` then ``chmod(...)`` leaks the file at the umask-default
    mode (typically 0o644) between the two calls — a brief window but one that
    matters for a file containing ``ATLAS_AI_SECRET``. Here we open with
    ``O_CREAT | O_WRONLY | O_TRUNC`` at mode 0o600 so the file never exists at
    a laxer mode.
    """
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(content)
