# Atlas

Local-first paper reviewer for compilers / MLIR / DSL research. Reads arXiv every morning, ranks / summarizes / answers follow-ups using your local AI CLI. **$0 recurring cost** — uses your subscription via `codex exec` (default) or `claude -p`.

## Prerequisites

One-time host-side setup:

| Tool | Install | Why |
| --- | --- | --- |
| Docker Desktop | [docker.com](https://www.docker.com/products/docker-desktop/) | Runs the Atlas container |
| Python 3.12+ | `brew install python@3.12` | Runs the host AI runner (subprocess wrapper around your CLIs) |
| Codex CLI | `brew install --cask codex` then `codex login` | Default AI backend; uses your ChatGPT subscription |
| Claude Code CLI (optional) | [install](https://docs.claude.com/en/docs/claude-code) | Alternative AI backend; uses your Claude Pro/Max subscription |

You need at least one of Codex / Claude installed and logged in. The Codex and Claude CLIs are macOS-native binaries whose credentials live in `~/.codex/` and the macOS Keychain — neither can run inside a Linux container. Atlas solves this with a tiny **host-side runner** that the container calls through `host.docker.internal`.

## Start / stop the project (Docker-only)

One-time bootstrap (first run ever):

```bash
git clone <repo> paper-dashboard
cd paper-dashboard
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e .                       # installs the `atlas` CLI (runner only)
```

Every time you want to use it:

```bash
# 1. Start the host runner (needed so the container can reach your CLIs).
#    Generates ~/.atlas/runner.secret on first run (mode 0600).
source .venv/bin/activate
atlas start-runner

# 2. Start Atlas in Docker. Rebuilds on code changes.
docker compose up --build -d

# 3. Open the app.
open http://localhost:8765
```

To shut everything down cleanly:

```bash
docker compose down            # stops the container
atlas stop-runner              # stops the host runner
```

That's the whole lifecycle. Data (papers DB, PDFs, runner secret) lives in `~/.atlas/` and survives across restarts.

### Status / logs

```bash
atlas status                   # runner: running / not running
docker compose ps              # container status
docker compose logs -f atlas   # tail the backend log
atlas runner-logs              # tail the host AI runner log
atlas doctor                   # print live security posture
```

## How the pieces fit

```
[ Mac host ]                                 [ Docker container ]
 ┌── atlas-ai-runner ──┐                      ┌── atlas backend ──┐
 │ 127.0.0.1:8766       │  ←── HTTP (NDJSON) ──│ FastAPI on :8765   │
 │ spawns codex / claude│      bearer-auth'd    │ sends typed jobs   │
 │ (uses your subscription)                     │                    │
 └──────────────────────┘                      └────────────────────┘
         ▲                                             ▲
         │                                             │
         └───────── ~/.atlas/ (shared volume) ─────────┘
            (PDFs, SQLite DB, runner secret)
```

- Container backend serves HTTP, renders the UI, orchestrates work.
- Host runner spawns the CLI subprocesses (where Keychain creds live).
- Both read/write the same physical `~/.atlas/` so PDFs and DB state are shared.

## AI backends

| Backend | CLI | Auth |
| --- | --- | --- |
| **Codex (default)** | `codex` | `~/.codex/` after `codex login` (ChatGPT plan) |
| Claude | `claude` | macOS Keychain after `claude` first run (Claude Pro/Max plan) |

Pick in the top-bar segmented control. The Codex model dropdown shows every model your `codex` CLI lists (GPT-5.4, GPT-5.4 mini, GPT-5.3 Codex, etc.). The Claude dropdown shows Opus / Sonnet / Haiku. A backend that isn't installed is greyed out; `/api/health` reports per-backend availability.

### Safety posture

- **Codex** is always invoked with `--sandbox read-only` + `-c sandbox_mode="read-only"` (overrides any ambient `~/.codex/config.toml`) and `--skip-git-repo-check` so it works from `~/.atlas/`.
- **Claude** is restricted to `--allowedTools Read` when PDF access is needed, nothing else.
- The host runner binds loopback only, requires a bearer token on every call, validates the Host header (DNS-rebinding defense), enforces per-backend model allowlists, rate-limits 30 req/min with 4 concurrent, and logs only structured events (no prompt or response text).

`atlas doctor` prints all of this at runtime.

## Importing papers

Three ways to open a paper:

1. **arXiv** — paste an arXiv URL or ID into the left-panel URL bar.
2. **Any PDF URL** — paste a direct PDF URL; Atlas downloads it and creates a synthetic id (`custom-<sha>`).
3. **Local upload** — click "Upload PDF" under the URL bar; imported into the same storage.

All three land in the same SQLite row; Summarize / Ask / Flow diagram all work on any of them.

## Automatic daily refresh

A scheduler inside the backend container runs hourly: if today's digest hasn't been built yet, it fetches arXiv (without AI ranking — cheap) so the list is fresh without you clicking anything. Manual rebuild: `curl "http://localhost:8765/api/digest?build=true"`.

arXiv occasionally rate-limits; the client retries 429/timeouts with backoff (2s → 6s → 15s). If it eventually gives up, the UI shows whatever papers are already cached instead of an error.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `[` / `]` | Toggle left / right panel |
| `S` | Summarize current paper |
| `/` | Focus URL bar |
| `?` | Show shortcuts overlay |
| `Cmd+K` | Command palette |
| `Esc` | Close overlay |

## Endpoints

- `GET /api/health` — `{ai, backends: {claude, codex}, default_backend, papers_today}`
- `GET /api/stats` — streak, total papers, papers today
- `GET /api/digest?build=true[&backend=claude|codex&rank=false]`
- `GET /api/papers/{arxiv_id}` — metadata (auto-imports arXiv IDs; `custom-*` ids are local-only)
- `GET /api/pdf/{arxiv_id}` — PDF bytes (arXiv ids streamed from arxiv.org, `custom-*` ids served from disk)
- `POST /api/papers/import-url` — body `{url}` → `{arxiv_id: "custom-..."}`
- `POST /api/papers/import-upload` — multipart file → `{arxiv_id: "custom-..."}`
- `POST /api/summarize/{arxiv_id}[?backend=claude|codex&model=...]` — SSE summary
- `POST /api/ask/{arxiv_id}[?backend=claude|codex&model=...]` — SSE chat; body `{question, history}`
- `GET /api/conversations/{arxiv_id}` — persisted chat history
- `GET /api/build-progress?date=YYYY-MM-DD` — SSE digest build progress

## Data

Everything lives under `~/.atlas/` (shared between host and container):

- `atlas.db` — SQLite (papers, builds, conversations, highlights, glossary, prefs, events)
- `pdfs/` — cached PDFs (arXiv + custom imports)
- `runner.secret` — bearer token for host↔container AI calls (mode 0600)
- `runner.env` — KEY=VALUE version of the same secret, consumed by docker-compose
- `atlas-runner.log` — runner log

Override with `ATLAS_DATA_DIR=/some/path` (set on both the host and in docker-compose environment for consistency).

## Prebuilt image (GHCR)

Every push to `main` publishes a multi-tag image. Instead of `docker compose up --build`, you can skip the build:

```bash
atlas start-runner
docker run --rm -p 8765:8765 \
  --env-file ~/.atlas/runner.env \
  -e ATLAS_AI_PROXY=http://host.docker.internal:8766 \
  -e ATLAS_DATA_DIR=${HOME}/.atlas \
  -v ${HOME}/.atlas:${HOME}/.atlas \
  ghcr.io/tavakkoliamirmohammad/atlas-reader:latest
```

## Tests

```bash
source .venv/bin/activate
pytest -q                              # backend (169 tests)
cd frontend && pnpm test:run           # frontend (37 tests)
```

## Design

Full design at `docs/superpowers/specs/2026-04-19-atlas-paper-reviewer-design.md`. Implementation plans at `docs/superpowers/plans/`.
