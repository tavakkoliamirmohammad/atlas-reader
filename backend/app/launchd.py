"""Generate, install, and uninstall a user-level launchd plist for Atlas autostart."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from app import db


LABEL = "com.amir.atlas"


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def render_plist() -> str:
    log = db.data_dir() / "atlas.log"
    python = sys.executable
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python}</string>
        <string>-m</string>
        <string>app.cli</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
"""


def _uid() -> int:
    return os.getuid()


def _bootstrap() -> None:
    subprocess.run(
        ["launchctl", "bootstrap", f"gui/{_uid()}", str(plist_path())],
        check=False, capture_output=True,
    )


def _bootout() -> None:
    subprocess.run(
        ["launchctl", "bootout", f"gui/{_uid()}/{LABEL}"],
        check=False, capture_output=True,
    )


def install() -> str:
    target = plist_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_plist())
    _bootstrap()
    return f"installed: {target}"


def uninstall() -> str:
    target = plist_path()
    if not target.exists():
        return "not installed"
    _bootout()
    target.unlink()
    return f"removed: {target}"
