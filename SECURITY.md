# Security

## Reporting a vulnerability

Open a **GitHub security advisory** on this repository (Security tab → "Report a vulnerability"). Please do not file a public issue for suspected vulnerabilities.

Expect a first response within a few days. For low-severity hardening ideas, a regular issue or PR is fine.

## Threat model (short version)

Atlas is a local-first tool. The interesting attack surface is the **AI runner** — a loopback HTTP daemon that spawns `codex` / `claude` subprocesses on the user's host.

Defenses (verified by `backend/tests/test_runner_security.py`):

- Bind host: `127.0.0.1` on macOS/Windows (Docker Desktop maps `host.docker.internal` back to host loopback). On Linux the runner defaults to `0.0.0.0` because the bridge gateway IP can't reach a loopback-only listener — and **the runner logs a warning on every Linux start** to make this visible. Bearer auth + Host-header allowlist remain the security boundary; the bearer token has 256 bits of entropy and `secrets.compare_digest` is constant-time, so brute force isn't a meaningful threat. For tighter isolation on a shared / LAN-exposed Linux host, firewall the runner port from non-loopback sources or set `ATLAS_RUNNER_HOST` explicitly to the docker bridge IP.
- Bearer token required for every request. Secret at `~/.atlas/runner.secret`, mode 0600.
- Host-header allowlist (`localhost`, `127.0.0.1`, `host.docker.internal`) — DNS-rebinding defense.
- Typed jobs only (Pydantic `RunRequest`); no raw argv, no shell.
- Concurrency semaphore (4) + token-bucket rate limiter (30 req/min).
- Per-task timeout (60–180s); subprocess killed on abandon.
- Codex always gets `--sandbox read-only` + `sandbox_mode="read-only"` (double-override against user's `~/.codex/config.toml`).
- Claude gets `--allowedTools Read` only when the task needs file access; never Write/Bash/WebFetch.
- Structured logs only: job id / task / backend / model / duration / bytes — never prompt text or response text.

## Known limits

- Any local process running as the same UID can read `~/.atlas/runner.secret`. This is the inherent ceiling of localhost-daemon security on macOS; a hostile local process is treated as equivalent to the user.
- When Atlas is hosted behind Cloudflare Access (invite-only static UI), the browser-to-backend hop is plain HTTP to localhost. This is fine because it's loopback, but do NOT expose the backend on a public port.
- The AI CLIs themselves (`codex`, `claude`) are out of scope for this threat model — Atlas trusts the binaries you have installed.
