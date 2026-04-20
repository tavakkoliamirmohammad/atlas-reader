# Atlas

Local-first paper reviewer for compilers / MLIR / DSL research. Reads arXiv every morning, ranks with Claude Haiku, summarizes on-demand with Opus, and keeps a reading streak. **$0 recurring cost** — uses your Claude Pro/Max subscription via `claude -p`.

## Status

**v1 complete.** Plans 1-4 shipped:

- **Plan 1 — Backend:** FastAPI, SQLite, arXiv fetch, PDF streaming, CLI
- **Plan 2 — Frontend shell:** React + Vite + Tailwind, embedded PDF reader, 6 themes, Light/Sepia/Dark
- **Plan 3 — AI features:** tier ranking, streamed 10-section summary, chat Q&A, persisted history
- **Plan 4 — Polish + ops:** keyboard shortcuts, Cmd+K command palette, ? shortcuts overlay, streak badge, launchd autostart

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

## CLI

| Command | What it does |
| --- | --- |
| `atlas up` | Build frontend + start backend + open browser (the one command) |
| `atlas start` | Start the backend on http://localhost:8765 |
| `atlas stop` | Stop the backend |
| `atlas restart` | Stop + start (no rebuild) |
| `atlas status` | Show pid + URL |
| `atlas logs` | Print the backend log |
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

- `GET /api/health` — AI availability + papers today
- `GET /api/stats` — streak, total papers, papers today
- `GET /api/digest?build=true` — fetch today's arXiv papers (runs ranker if AI on)
- `GET /api/papers/{arxiv_id}` — single paper (auto-imports unknown IDs from arXiv)
- `GET /api/pdf/{arxiv_id}` — streams PDF directly from arXiv (no disk cache)
- `POST /api/summarize/{arxiv_id}` — SSE 10-section summary (Opus)
- `POST /api/ask/{arxiv_id}` — SSE chat (Sonnet); body `{question, history}`
- `GET /api/conversations/{arxiv_id}` — persisted chat history
- `GET /api/build-progress?date=YYYY-MM-DD` — SSE digest build progress

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
