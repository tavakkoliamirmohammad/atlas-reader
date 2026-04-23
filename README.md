# Atlas

> A local-first daily reviewer for arXiv papers in compilers, PL, and MLIR.
> Uses *your* `codex` or `claude` CLI subscription — **no API keys, \$0 recurring cost**.

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange)

Atlas fetches today's arXiv papers in the categories you care about, gives each a deep 10-section summary on demand, lets you highlight + ask follow-ups, and remembers everything locally. All AI work is done by spawning your own `codex` / `claude` CLI, so nothing leaves your machine and nothing is billed to an API account.

![Atlas screenshot](docs/screenshot.png)

## Quick start (Docker — recommended)

Docker builds the whole app. You don't need Node, pnpm, or even Python on the host — just Docker and your AI CLI.

```bash
git clone https://github.com/tavakkoliamirmohammad/atlas-reader atlas && cd atlas
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e .                           # installs the `atlas` CLI
codex login                                # or run `claude` once
atlas up-docker                            # http://localhost:8765
```

`atlas up-docker` starts the host AI runner, builds + starts the backend/frontend container, and opens the browser. Stop with `atlas down-docker`.

> Docker's multi-stage build does `pnpm install && pnpm build` inside the `node:20-alpine` build stage — the compiled SPA is copied into the Python runtime image as static files. No Node toolchain needed on your machine.

### Native mode (no Docker)

If you want to run everything directly on the host (no container, ~2× less memory), you do need Node + pnpm because the backend serves `frontend/dist/` which must be built locally:

```bash
cd frontend && pnpm install && pnpm build && cd ..
atlas up                                   # http://localhost:8765
```

## Run modes

| Mode | Command | URL |
| --- | --- | --- |
| **Docker** (recommended) | `atlas up-docker` | http://localhost:8765 |
| **Native** | `atlas up` | http://localhost:8765 |
| **Dev** (hot reload) | `atlas start-runner` + `pnpm --dir frontend dev` + `uvicorn app.main:app --reload --port 8765` | http://localhost:5173 |
| **Hosted UI + local backend** | `atlas start` | hosted URL (see below) |

Status: `atlas status` · Logs: `atlas runner-logs`, `docker compose logs -f atlas`.

## Architecture

Two processes, always:

```
┌─────────────────────────────┐            ┌────────────────────────────┐
│  Backend (container or host) │ ──HTTP──▶ │  AI runner (host only)     │
│  FastAPI · :8765             │   NDJSON  │  Spawns codex / claude     │
│  Serves SPA + REST + SSE     │ ◀─stream─ │  Keychain + ~/.codex here  │
└─────────────────────────────┘            └────────────────────────────┘
               ▲                                        ▲
               └──────── shared ~/.atlas/ ──────────────┘
                  (SQLite, PDFs, runner.secret)
```

The runner cannot live in a container — `codex` / `claude` read your macOS Keychain and `~/.codex/` credentials. Put the backend anywhere; the runner stays on your machine. See `CLAUDE.md` for the fuller walk-through.

## Hosted UI (invite-only, \$0)

Deploy once, every invited user runs their own backend. The page talks to each user's `localhost:8765` — no shared AI.

1. Push to GitHub (private is fine).
2. **Cloudflare Pages** → connect repo. Build command `cd frontend && pnpm install && pnpm build`; output `frontend/dist`.
3. **Cloudflare Access** → add an Access app over the Pages URL; policy **Emails → include** your invite list. Free up to 50 users.
4. Users export `ATLAS_CORS_ORIGINS="https://<your-pages-url>"` before running `atlas start`.

## Data

Everything under `~/.atlas/`:
- `atlas.db` — SQLite (papers, conversations, highlights, glossary).
- `pdfs/` — local PDFs for custom URL/upload imports. arXiv PDFs are streamed on demand.
- `runner.secret` — bearer token for the runner, mode 0600.

Override the location with `ATLAS_DATA_DIR=/path/to/dir`.

## Tests

```bash
pytest -q                                # backend (171 tests)
pnpm --dir frontend test:run             # frontend (37 tests)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and design discussion welcome in issues; security reports via the Security tab (see [SECURITY.md](SECURITY.md)).

## License

**[PolyForm Noncommercial 1.0.0](LICENSE)** — personal, research, hobby, educational, charitable, and non-profit use only. **No commercial use.** Software is provided as-is, with no warranty and no obligation on the author to fix bugs or provide support. See [LICENSE](LICENSE) for the full terms.

If you want a commercial license, open an issue.
