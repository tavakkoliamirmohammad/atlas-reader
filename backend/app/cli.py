"""`atlas` CLI: start, stop, status, logs, open, up, restart, doctor.

`atlas start` brings up two processes:
  1. the backend (uvicorn on 8765)
  2. the AI runner (uvicorn on 8766) — a host-only daemon that spawns claude
     / codex subprocesses, so Docker instances of Atlas can reach host creds.

Both run under this CLI's lifecycle; their PIDs are tracked in ~/.atlas/.
"""

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

from app import db, launchd, secret_store


PORT = 8765
RUNNER_PORT = 8766


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


# ---------- pid + log file helpers ----------
def _backend_pid_file() -> Path:
    return db.data_dir() / "atlas.pid"


def _runner_pid_file() -> Path:
    return db.data_dir() / "atlas-runner.pid"


def _backend_log() -> Path:
    return db.data_dir() / "atlas.log"


def _runner_log() -> Path:
    return db.data_dir() / "atlas-runner.log"


def _read_pid(path: Path) -> Optional[int]:
    if not path.exists():
        return None
    try:
        return int(path.read_text().strip())
    except ValueError:
        return None


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


# ---------- runner lifecycle ----------
def _start_runner() -> None:
    """Start the AI runner if not already running. Writes PID to disk."""
    if (pid := _read_pid(_runner_pid_file())) and _is_alive(pid):
        print(f"runner already running (pid {pid}) on http://127.0.0.1:{RUNNER_PORT}")
        return
    # Generate + persist secret if this is the first run.
    secret_store.ensure()
    log_fp = _runner_log().open("ab")
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.runner_main"],
        stdout=log_fp, stderr=log_fp,
        start_new_session=True,
    )
    _runner_pid_file().write_text(str(proc.pid))
    print(f"runner started (pid {proc.pid}) on http://127.0.0.1:{RUNNER_PORT}")


def _stop_runner() -> None:
    pid = _read_pid(_runner_pid_file())
    if pid is None:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    _runner_pid_file().unlink(missing_ok=True)
    print(f"runner stopped (pid {pid})")


# ---------- top-level commands ----------
def cmd_start() -> int:
    _start_runner()
    if (pid := _read_pid(_backend_pid_file())) and _is_alive(pid):
        print(f"backend already running (pid {pid})")
        return 0
    log = _backend_log().open("ab")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(PORT)],
        stdout=log, stderr=log,
        start_new_session=True,
    )
    _backend_pid_file().write_text(str(proc.pid))
    print(f"started (pid {proc.pid}) on http://localhost:{PORT}")
    return 0


def cmd_stop() -> int:
    pid = _read_pid(_backend_pid_file())
    if pid is not None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        _backend_pid_file().unlink(missing_ok=True)
        print(f"stopped (pid {pid})")
    else:
        print("backend not running")
    _stop_runner()
    return 0


def cmd_status() -> int:
    backend_pid = _read_pid(_backend_pid_file())
    runner_pid = _read_pid(_runner_pid_file())
    if backend_pid and _is_alive(backend_pid):
        print(f"backend: running (pid {backend_pid}) on http://localhost:{PORT}")
    else:
        print("backend: not running")
    if runner_pid and _is_alive(runner_pid):
        print(f"runner:  running (pid {runner_pid}) on http://127.0.0.1:{RUNNER_PORT}")
    else:
        print("runner:  not running")
    return 0


def cmd_logs() -> int:
    log = _backend_log()
    if not log.exists():
        print("no backend log yet")
        return 0
    sys.stdout.write(log.read_text())
    return 0


def cmd_runner_logs() -> int:
    log = _runner_log()
    if not log.exists():
        print("no runner log yet")
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
    if (pid := _read_pid(_backend_pid_file())) and _is_alive(pid):
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


def cmd_start_runner() -> int:
    """Start ONLY the host AI runner (no backend). Used with Docker Compose."""
    _start_runner()
    return 0


def cmd_stop_runner() -> int:
    """Stop ONLY the host AI runner. Leaves any running backend alone."""
    _stop_runner()
    return 0


def _have_docker() -> bool:
    return subprocess.run(["which", "docker"], capture_output=True).returncode == 0


def cmd_up_docker() -> int:
    """One-command Docker startup: host runner + containerized backend/frontend.

    The runner MUST stay on the host because codex/claude CLIs read macOS
    Keychain and ~/.codex/ tokens (impossible to containerize without moving
    to paid API keys). This command wraps the two-step startup behind one
    invocation:
      1. Start the host runner (idempotent; creates runner.secret/env).
      2. `docker compose up --build -d` for backend + frontend.
      3. Wait for http://localhost:8765/api/health to come up.
      4. Open browser.
    """
    if not _have_docker():
        print("docker not found on PATH; install Docker Desktop first", file=sys.stderr)
        return 1

    # A native backend on :8765 would clash with the container's published port.
    if (pid := _read_pid(_backend_pid_file())) and _is_alive(pid):
        print(f"native backend is running (pid {pid}); stopping so Docker can bind :{PORT}")
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        _backend_pid_file().unlink(missing_ok=True)
        time.sleep(0.5)

    _start_runner()

    print("building and starting containers (docker compose up --build -d)...")
    proc = subprocess.run(
        ["docker", "compose", "up", "--build", "-d"],
        cwd=_project_root(),
    )
    if proc.returncode != 0:
        print(f"docker compose failed (exit {proc.returncode})", file=sys.stderr)
        return proc.returncode

    if _wait_for_health(timeout=30):
        print(f"ready: http://localhost:{PORT}")
        webbrowser.open(f"http://localhost:{PORT}")
        return 0
    print(
        f"container didn't respond on http://localhost:{PORT} within 30s; "
        "try `docker compose logs atlas`",
        file=sys.stderr,
    )
    return 1


def cmd_down_docker() -> int:
    """Tear down Docker stack + host runner started by `up-docker`."""
    if _have_docker():
        subprocess.run(["docker", "compose", "down"], cwd=_project_root())
    _stop_runner()
    return 0


def cmd_doctor() -> int:
    """Print the live security posture of the runner + backend."""
    print("=== Atlas doctor ===")
    secret = secret_store.load()
    secret_file = db.data_dir() / "runner.secret"
    env_file = db.data_dir() / "runner.env"
    print(f"secret file:   {secret_file}  "
          f"{'present' if secret_file.exists() else 'MISSING'}  "
          f"mode={oct(secret_file.stat().st_mode & 0o777) if secret_file.exists() else '-'}")
    print(f"env file:      {env_file}  "
          f"{'present' if env_file.exists() else 'MISSING'}  "
          f"mode={oct(env_file.stat().st_mode & 0o777) if env_file.exists() else '-'}")
    print(f"secret loaded: {'yes' if secret else 'NO'}")
    runner_pid = _read_pid(_runner_pid_file())
    print(f"runner:        {'running pid '+str(runner_pid) if runner_pid and _is_alive(runner_pid) else 'not running'}")
    print(f"runner URL:    http://127.0.0.1:{RUNNER_PORT}  (loopback only)")
    print("sandbox:       codex → read-only (forced);  claude → Read tool only when needed")
    print("rate limit:    30 requests/min, concurrency 4, per-task timeout 60–180s")
    return 0


def cmd_install_launchd() -> int:
    print(launchd.install())
    return 0


def cmd_uninstall_launchd() -> int:
    print(launchd.uninstall())
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="atlas")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in (
        "start", "stop", "status", "logs", "runner-logs",
        "start-runner", "stop-runner",
        "open", "restart", "up", "up-docker", "down-docker", "doctor",
        "install-launchd", "uninstall-launchd",
    ):
        sub.add_parser(name)
    args = parser.parse_args(argv)
    return {
        "start":             cmd_start,
        "stop":              cmd_stop,
        "status":            cmd_status,
        "logs":              cmd_logs,
        "runner-logs":       cmd_runner_logs,
        "start-runner":      cmd_start_runner,
        "stop-runner":       cmd_stop_runner,
        "open":              cmd_open,
        "restart":           cmd_restart,
        "up":                cmd_up,
        "up-docker":         cmd_up_docker,
        "down-docker":       cmd_down_docker,
        "doctor":            cmd_doctor,
        "install-launchd":   cmd_install_launchd,
        "uninstall-launchd": cmd_uninstall_launchd,
    }[args.cmd]()


if __name__ == "__main__":
    sys.exit(main())
