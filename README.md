# Atlas

Local-first paper reviewer for compilers / MLIR / DSL research. Reads arXiv every morning, ranks / summarizes / answers follow-ups using your local AI CLI. **$0 recurring cost** — uses your subscription via `claude -p` or `codex exec`.

## Status

**v1 complete.** Plans 1-4 shipped, plus Codex backend + Docker-AI integration:

- **Plan 1 — Backend:** FastAPI, SQLite, arXiv fetch, PDF streaming, CLI
- **Plan 2 — Frontend shell:** React + Vite + Tailwind, embedded PDF reader, 6 themes, Light/Sepia/Dark
- **Plan 3 — AI features:** tier ranking, streamed 10-section summary, chat Q&A, persisted history
- **Plan 4 — Polish + ops:** keyboard shortcuts, Cmd+K command palette, ? shortcuts overlay, streak badge, launchd autostart
- **Plan 5 — Multi-backend + Docker-AI:** Codex backend, per-session picker in the top bar (Codex / Claude), host AI runner daemon so the Docker build can call out to Keychain-auth'd CLIs. Default backend: **Codex**.

## Quick start

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

cd frontend
pnpm install
pnpm build
cd ..

atlas up      # build + start + open in browser
```

## Autostart on login

```bash
atlas install-launchd     # writes ~/Library/LaunchAgents/com.amir.atlas.plist
```

To remove: `atlas uninstall-launchd`.

## AI backends

Atlas supports two AI backends, picked in the top bar. **Default is Codex**; Claude is one click away.

| Backend | CLI needed | Auth |
| --- | --- | --- |
| Codex | `codex` (install via Homebrew; OpenAI's Codex CLI) | stored in `~/.codex/` after `codex login` |
| Claude | `claude` (Claude Code CLI) | macOS Keychain after `claude` first run |

Both stream output to the UI. Rankers, summarizers, and chat all honor the picker. A backend that isn't installed is greyed out in the picker; `/api/health` returns `{claude, codex}` per-backend availability.

### Codex safety

Every `codex exec` invocation Atlas makes is forced to `--sandbox read-only` (overrides ambient `~/.codex/config.toml`), so papers-as-prompt-injection can't escalate to file writes or shell commands. Claude calls use `--allowedTools Read` only.

## Docker

Spin up with two commands:

```bash
atlas start          # starts the host AI runner (one-time setup; generates ~/.atlas/runner.secret)
docker compose up --build
```

Open http://localhost:8765.

Data persists in `./atlas-data/` (mounted into the container at `/data`).

### How Docker gets AI access

The Codex and Claude CLIs are macOS-native arm64 binaries whose credentials live in Keychain — neither can run inside a Linux container. Instead, `atlas start` spawns a small **host-side AI runner** (`atlas-ai-runner`) on `127.0.0.1:8766` that the container calls through `host.docker.internal:8766`. The runner:

- Binds loopback only; rejects non-loopback `Host:` headers (DNS-rebinding defense).
- Requires a bearer token from `~/.atlas/runner.secret` (auto-generated, mode 0600). `docker compose` reads it via `env_file: ~/.atlas/runner.env`.
- Accepts only typed jobs (`backend + task + model + prompt + directive`). No raw argv. Model allowlists + directive sanitization prevent argv smuggling.
- Rate-limits 30 req/min, max 4 concurrent, per-task timeout 60–180 s.
- Logs structured events only — no prompt or response text.

`atlas stop` kills both the backend and the runner. `atlas doctor` prints the live security posture.

### Prebuilt image (GHCR)

Every push to `main` publishes a multi-tag image to GitHub Container Registry:

```bash
atlas start
docker run --rm -p 8765:8765 --env-file ~/.atlas/runner.env \
  -e ATLAS_AI_PROXY=http://host.docker.internal:8766 \
  -v $(pwd)/atlas-data:/data \
  ghcr.io/tavakkoliamirmohammad/atlas-reader:latest
```

Tags available: `latest`, `main`, a short commit SHA (e.g. `sha-75ccae5`), and any semver tag you push (`v0.1.0` → both `v0.1.0` and `0.1.0`).

### Running without the host runner

If you don't run `atlas start` on the host, `/api/health` inside the container reports both backends as unavailable and Ask/Summarize return 503. The reader, digest (unranked), highlights, search, and archive range selector all still work.

## CLI

| Command | What it does |
| --- | --- |
| `atlas up` | Build frontend + start backend + runner + open browser (the one command) |
| `atlas start` | Start the backend on 8765 + AI runner on 8766 |
| `atlas stop` | Stop both |
| `atlas restart` | Stop + start (no rebuild) |
| `atlas status` | Show both pids + URLs |
| `atlas logs` | Print the backend log |
| `atlas runner-logs` | Print the AI runner log |
| `atlas doctor` | Print live security posture (secret file mode, sandbox flags, rate limit) |
| `atlas open` | Open the dashboard in the default browser |
| `atlas install-launchd` | Install login-autostart plist |
| `atlas uninstall-launchd` | Remove the plist |

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
- `GET /api/digest?build=true[&backend=claude|codex]` — fetch + rank today's arXiv papers
- `GET /api/papers/{arxiv_id}` — single paper (auto-imports unknown IDs from arXiv)
- `GET /api/pdf/{arxiv_id}` — streams PDF directly from arXiv (no disk cache)
- `POST /api/summarize/{arxiv_id}[?backend=claude|codex&model=...]` — SSE summary
- `POST /api/ask/{arxiv_id}[?backend=claude|codex&model=...]` — SSE chat; body `{question, history}`
- `GET /api/conversations/{arxiv_id}` — persisted chat history
- `GET /api/build-progress?date=YYYY-MM-DD` — SSE digest build progress

`model=` is a Claude-specific override (`opus`/`sonnet`/`haiku`); Codex picks its own model per task. Omitting `backend=` falls back to the server default (`codex`).

## Data

Lives at `~/.atlas/`:
- `atlas.db` — SQLite (papers, builds, conversations, prefs, events)
- `atlas.log` — backend log

Override with `ATLAS_DATA_DIR=/some/path`.

## Tests

```bash
pytest -v          # backend
cd frontend && pnpm test:run
```

## Design

Full design at `docs/superpowers/specs/2026-04-19-atlas-paper-reviewer-design.md`. Implementation plans at `docs/superpowers/plans/`.
