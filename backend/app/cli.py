"""`atlas` CLI: start, stop, status, logs, open, up, restart."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Optional, Sequence

from app import db


PORT = 8765


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _frontend_dir() -> Path:
    return _project_root() / "frontend"


def _wait_for_health(timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    url = f"http://localhost:{PORT}/api/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.2)
    return False


def _build_frontend() -> int:
    fd = _frontend_dir()
    if not (fd / "package.json").exists():
        print("no frontend/ directory; skipping build")
        return 0
    pm = "pnpm" if subprocess.run(["which", "pnpm"], capture_output=True).returncode == 0 else "npm"
    print(f"building frontend ({pm} build)...")
    res = subprocess.run([pm, "run", "build"], cwd=fd)
    if res.returncode != 0:
        print(f"frontend build failed (exit {res.returncode})", file=sys.stderr)
    return res.returncode


def _pid_file() -> Path:
    return db.data_dir() / "atlas.pid"


def _log_file() -> Path:
    return db.data_dir() / "atlas.log"


def _read_pid() -> Optional[int]:
    p = _pid_file()
    if not p.exists():
        return None
    try:
        return int(p.read_text().strip())
    except ValueError:
        return None


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def cmd_start() -> int:
    if (pid := _read_pid()) and _is_alive(pid):
        print(f"already running (pid {pid})")
        return 0
    log = _log_file().open("ab")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(PORT)],
        stdout=log, stderr=log,
        start_new_session=True,
    )
    _pid_file().write_text(str(proc.pid))
    print(f"started (pid {proc.pid}) on http://localhost:{PORT}")
    return 0


def cmd_stop() -> int:
    pid = _read_pid()
    if pid is None:
        print("not running")
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    _pid_file().unlink(missing_ok=True)
    print(f"stopped (pid {pid})")
    return 0


def cmd_status() -> int:
    pid = _read_pid()
    if pid and _is_alive(pid):
        print(f"running (pid {pid}) on http://localhost:{PORT}")
    else:
        print("not running")
    return 0


def cmd_logs() -> int:
    log = _log_file()
    if not log.exists():
        print("no log file yet")
        return 0
    sys.stdout.write(log.read_text())
    return 0


def cmd_open() -> int:
    webbrowser.open(f"http://localhost:{PORT}")
    return 0


def cmd_restart() -> int:
    cmd_stop()
    time.sleep(0.5)
    return cmd_start()


def cmd_up() -> int:
    """Build frontend + start backend + wait for health + open browser."""
    rc = _build_frontend()
    if rc != 0:
        return rc
    if (pid := _read_pid()) and _is_alive(pid):
        print(f"backend already running (pid {pid}); restarting to pick up changes")
        cmd_stop()
        time.sleep(0.5)
    cmd_start()
    if _wait_for_health():
        print(f"ready: http://localhost:{PORT}")
        webbrowser.open(f"http://localhost:{PORT}")
    else:
        print(f"server didn't respond on http://localhost:{PORT} within 10s; check `atlas logs`",
              file=sys.stderr)
        return 1
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="atlas")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("start", "stop", "status", "logs", "open", "restart", "up"):
        sub.add_parser(name)
    args = parser.parse_args(argv)
    return {
        "start":   cmd_start,
        "stop":    cmd_stop,
        "status":  cmd_status,
        "logs":    cmd_logs,
        "open":    cmd_open,
        "restart": cmd_restart,
        "up":      cmd_up,
    }[args.cmd]()


if __name__ == "__main__":
    sys.exit(main())
