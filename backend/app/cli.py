"""`atlas` CLI: Docker-backed runtime + host AI runner.

Atlas runs in two pieces:

1. The **backend** (FastAPI + frontend bundle) in a Docker container. Its
   host-published port is controlled by ``ATLAS_PORT`` (default 8765).
2. The **AI runner** on the host, spawned directly by this CLI. It spawns
   ``codex`` / ``claude`` subprocesses that need host-side credentials
   (macOS Keychain, ``~/.codex``) so it cannot be containerized. Port is
   controlled by ``ATLAS_RUNNER_PORT`` (default 8766).

``atlas up`` starts the runner, builds/starts the backend container, waits
for health, and opens the browser. ``atlas up --port N --runner-port N`` also
persists those ports into ``~/.atlas/runner.env`` so every later command
(``down``, ``status``, ``logs``, ``open``, ``doctor``) sees the same values.

See ``docs/superpowers/specs/2026-04-22-docker-only-and-configurable-ports-design.md``
for the full design.
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

from app import db, launchd, port_config, secret_store


# ---------- paths ----------

def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


# ---------- runner PID / log ----------

def _runner_pid_file() -> Path:
    return db.data_dir() / "atlas-runner.pid"


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


# ---------- health check ----------

def _wait_for_health(timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    url = f"http://localhost:{port_config.backend_port()}/api/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.2)
    return False


# ---------- runner lifecycle ----------

def _start_runner() -> None:
    """Start the AI runner if not already running. Writes PID to disk."""
    if (pid := _read_pid(_runner_pid_file())) and _is_alive(pid):
        print(f"runner already running (pid {pid}) on http://127.0.0.1:{port_config.runner_port()}")
        return
    secret_store.ensure()
    log_fp = _runner_log().open("ab")
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.runner_main"],
        stdout=log_fp, stderr=log_fp,
        start_new_session=True,
    )
    _runner_pid_file().write_text(str(proc.pid))
    print(f"runner started (pid {proc.pid}) on http://127.0.0.1:{port_config.runner_port()}")


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


# ---------- docker helpers ----------

def _have_docker() -> bool:
    return subprocess.run(["which", "docker"], capture_output=True).returncode == 0


def _compose_args(*extra: str) -> list[str]:
    return ["docker", "compose", *extra]


# ---------- commands ----------

def cmd_up(args: argparse.Namespace) -> int:
    """Start host runner + backend container, wait for health, open browser."""
    if not _have_docker():
        print("docker not found on PATH; install Docker Desktop first", file=sys.stderr)
        return 1

    # Persist CLI port overrides BEFORE reading them so compose sees the new values.
    if args.port is not None or args.runner_port is not None:
        port_config.persist_ports(backend=args.port, runner=args.runner_port)
        if args.port is not None:
            os.environ["ATLAS_PORT"] = str(args.port)
        if args.runner_port is not None:
            os.environ["ATLAS_RUNNER_PORT"] = str(args.runner_port)

    backend_p = port_config.backend_port()
    runner_p = port_config.runner_port()

    if not port_config.is_port_free(backend_p):
        print(
            f"error: backend port {backend_p} is already in use on this host.\n"
            f"       pass `atlas up --port N` (or export ATLAS_PORT=N) to pick another.",
            file=sys.stderr,
        )
        return 1
    # Skip the runner pre-check when our own runner is already bound to it —
    # `_start_runner()` is idempotent for that case. Only foreign holders should
    # block startup.
    runner_pid = _read_pid(_runner_pid_file())
    runner_is_ours = runner_pid is not None and _is_alive(runner_pid)
    if not runner_is_ours and not port_config.is_port_free(runner_p):
        print(
            f"error: runner port {runner_p} is already in use on this host.\n"
            f"       pass `atlas up --runner-port N` (or export ATLAS_RUNNER_PORT=N) to pick another.",
            file=sys.stderr,
        )
        return 1

    _start_runner()

    print("building and starting containers (docker compose up --build -d)...")
    env = os.environ.copy()
    env["ATLAS_PORT"] = str(backend_p)
    env["ATLAS_RUNNER_PORT"] = str(runner_p)
    proc = subprocess.run(
        _compose_args("up", "--build", "-d"),
        cwd=_project_root(),
        env=env,
    )
    if proc.returncode != 0:
        print(f"docker compose failed (exit {proc.returncode})", file=sys.stderr)
        return proc.returncode

    if _wait_for_health(timeout=30):
        url = f"http://localhost:{backend_p}"
        print(f"ready: {url}")
        webbrowser.open(url)
        return 0
    print(
        f"container didn't respond on http://localhost:{backend_p} within 30s; "
        "try `atlas logs`",
        file=sys.stderr,
    )
    return 1


def cmd_down(_args: argparse.Namespace) -> int:
    """Tear down backend container + host runner."""
    if _have_docker():
        subprocess.run(_compose_args("down"), cwd=_project_root())
    _stop_runner()
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    """Show docker compose service status + runner PID/port."""
    if _have_docker():
        proc = subprocess.run(
            _compose_args("ps"),
            cwd=_project_root(),
            capture_output=True,
            text=True,
        )
        sys.stdout.write(proc.stdout)
    else:
        print("backend: docker not installed")
    print(f"backend port: {port_config.backend_port()}")
    runner_pid = _read_pid(_runner_pid_file())
    if runner_pid and _is_alive(runner_pid):
        print(f"runner:       running (pid {runner_pid}) on http://127.0.0.1:{port_config.runner_port()}")
    else:
        print("runner:       not running")
    return 0


def cmd_logs(_args: argparse.Namespace) -> int:
    """Stream `docker compose logs -f atlas`."""
    if not _have_docker():
        print("docker not found on PATH", file=sys.stderr)
        return 1
    proc = subprocess.run(
        _compose_args("logs", "-f", "atlas"),
        cwd=_project_root(),
    )
    return proc.returncode


def cmd_runner_logs(_args: argparse.Namespace) -> int:
    log = _runner_log()
    if not log.exists():
        print("no runner log yet")
        return 0
    sys.stdout.write(log.read_text())
    return 0


def cmd_open(_args: argparse.Namespace) -> int:
    webbrowser.open(f"http://localhost:{port_config.backend_port()}")
    return 0


def cmd_start_runner(_args: argparse.Namespace) -> int:
    _start_runner()
    return 0


def cmd_stop_runner(_args: argparse.Namespace) -> int:
    _stop_runner()
    return 0


def cmd_doctor(_args: argparse.Namespace) -> int:
    print("=== Atlas doctor ===")
    secret = secret_store.load()
    secret_file = db.data_dir() / "runner.secret"
    env_file = db.data_dir() / "runner.env"
    print(f"secret file:     {secret_file}  "
          f"{'present' if secret_file.exists() else 'MISSING'}  "
          f"mode={oct(secret_file.stat().st_mode & 0o777) if secret_file.exists() else '-'}")
    print(f"env file:        {env_file}  "
          f"{'present' if env_file.exists() else 'MISSING'}  "
          f"mode={oct(env_file.stat().st_mode & 0o777) if env_file.exists() else '-'}")
    print(f"secret loaded:   {'yes' if secret else 'NO'}")
    print(f"backend port:    {port_config.backend_port()}  (ATLAS_PORT / runner.env / default)")
    print(f"runner port:     {port_config.runner_port()}  (ATLAS_RUNNER_PORT / runner.env / default)")
    runner_pid = _read_pid(_runner_pid_file())
    print(f"runner process:  {'running pid '+str(runner_pid) if runner_pid and _is_alive(runner_pid) else 'not running'}")
    print(f"runner URL:      http://127.0.0.1:{port_config.runner_port()}  (loopback only)")
    print("sandbox:         codex → read-only (forced);  claude → Read tool only when needed")
    print("rate limit:      30 requests/min, concurrency 4, per-task timeout 60–180s")
    return 0


def cmd_install_launchd(_args: argparse.Namespace) -> int:
    print(launchd.install())
    return 0


def cmd_uninstall_launchd(_args: argparse.Namespace) -> int:
    print(launchd.uninstall())
    return 0


# ---------- argparse wiring ----------

def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="atlas")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_up = sub.add_parser("up", help="start backend container + host runner")
    p_up.add_argument("--port", type=int, default=None,
                      help="host port to publish the backend on (default 8765)")
    p_up.add_argument("--runner-port", type=int, default=None,
                      help="host port for the AI runner (default 8766)")

    for name in ("down", "status", "logs", "runner-logs",
                 "start-runner", "stop-runner", "open", "doctor",
                 "install-launchd", "uninstall-launchd"):
        sub.add_parser(name)

    args = parser.parse_args(argv)
    handlers = {
        "up":                cmd_up,
        "down":              cmd_down,
        "status":            cmd_status,
        "logs":              cmd_logs,
        "runner-logs":       cmd_runner_logs,
        "start-runner":      cmd_start_runner,
        "stop-runner":       cmd_stop_runner,
        "open":              cmd_open,
        "doctor":            cmd_doctor,
        "install-launchd":   cmd_install_launchd,
        "uninstall-launchd": cmd_uninstall_launchd,
    }
    return handlers[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
