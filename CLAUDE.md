# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Atlas — a local-first arXiv paper reviewer for compilers / MLIR / DSL research. It fetches arXiv daily, ranks / summarizes / answers follow-ups by shelling out to the user's locally-installed AI CLI (`codex` or `claude`), using their existing ChatGPT / Claude subscription. No API keys, no recurring cost.

## Commands

Python tooling assumes `.venv` is activated (or call the binaries under `.venv/bin/` explicitly).

```bash
# Backend tests (pytest config in pyproject.toml; tests live in backend/tests/)
pytest -q
pytest backend/tests/test_asker.py::test_ask_streams   # single test

# Frontend tests + build (pnpm)
cd frontend
pnpm test:run           # vitest, single pass
pnpm test               # vitest in watch mode
pnpm build              # tsc -b && vite build
pnpm lint               # eslint .
pnpm dev                # vite dev server on :5173, proxies /api to :8765
```

Service lifecycle uses the `atlas` CLI (installed by `pip install -e .`), not raw `kill`:

```bash
.venv/bin/atlas start           # host mode: backend on :8765 + runner on :8766
.venv/bin/atlas stop
.venv/bin/atlas status
.venv/bin/atlas start-runner    # runner ONLY (used with Docker Compose)
.venv/bin/atlas stop-runner
.venv/bin/atlas up              # builds frontend, restarts backend, opens browser
.venv/bin/atlas doctor          # print live security posture
docker compose up --build -d    # container mode: container backend + host runner
docker compose down
```

Backend serves the built frontend from `frontend/dist/` (set via `ATLAS_FRONTEND_DIST` or auto-detected by `main.py::_frontend_dist`). In dev, run `pnpm dev` and hit `http://localhost:5173/` — its proxy routes `/api` to `:8765`.

## Architecture

### Two-process split (critical — read before touching AI code)

Atlas runs as **two cooperating processes**:

```
[ Mac host ]                              [ Docker container (or host) ]
 atlas-ai-runner :8766   ←── HTTP NDJSON ──  atlas backend :8765
 spawns codex / claude                       FastAPI, UI, orchestration
 (Keychain creds live here)                  (ATLAS_AI_PROXY=http://host.docker.internal:8766)
        ▲                                           ▲
        └─────── shared ~/.atlas/ ──────────────────┘
           (SQLite, PDFs, runner.secret)
```

The backend never invokes `codex`/`claude` directly when `ATLAS_AI_PROXY` is set. It POSTs typed jobs to the runner, which spawns the actual CLI subprocess on the host (where the macOS Keychain / `~/.codex/` creds are). Both processes read/write the same physical `~/.atlas/` directory so PDF paths resolve identically on both sides.

In **host mode** (no `ATLAS_AI_PROXY`), `ai_backend.run_ai` falls through to `ai_local.stream_text` which spawns directly — same argv, same behavior.

### The AI call path

Every AI call funnels through two single-source-of-truth modules:

- **`backend/app/ai_backend.py`** — single entry point. Callers pass `(backend, task, directive, prompt, model?, enable_read_file?)`; it dispatches host-mode or proxy-mode and yields `str` chunks. Tasks are `summarize | ask | rank | glossary`, backends `claude | codex`. Default backend is **codex**. Per-(backend, task) default model table lives here (`_DEFAULT_MODELS`).
- **`backend/app/ai_argv.py`** — single argv builder. The ONLY place that translates a typed job into a shell command. Security invariants enforced here:
  - `codex` **always** gets `--sandbox read-only` + `-c sandbox_mode="read-only"` (double-override against any ambient `~/.codex/config.toml`) and `--skip-git-repo-check`.
  - `claude` gets `--allowedTools Read` only when `enable_read_file` is set; never Write/Bash/WebFetch.
  - Model names are validated against `CLAUDE_MODELS` / `CODEX_MODELS` allowlists.
  - Directives starting with `-` are rejected.

If you add a new AI backend or task, **update both files** — the runner and host-mode spawner share `ai_argv`, so security flags stay synchronized by construction.

Summarize / ask / rank / glossary each live in their own module (`summarizer.py`, `asker.py`, `ranker.py`, `glossary.py`) and all go through `ai_backend.run_ai`.

### Runner hardening (`backend/app/runner_main.py`)

The runner's defenses are verified by `tests/test_runner_security.py` — don't regress them:
- Binds `127.0.0.1` only (loopback)
- Bearer token required (from `~/.atlas/runner.secret`, mode 0600)
- Host-header allowlist (`localhost`, `127.0.0.1`, `host.docker.internal`) — DNS-rebinding defense
- Typed jobs only (Pydantic `RunRequest`); no raw argv, no shell
- Concurrency semaphore (4) + token-bucket rate limiter (30/min)
- Per-task timeout (60–180s); subprocess killed on abandon
- Structured logs only: job_id/task/backend/model/duration/bytes — never prompt text or response text

### Data & storage

Everything persists under `ATLAS_DATA_DIR` (default `~/.atlas/`):
- `atlas.db` — SQLite. Schema in `backend/app/db.py::SCHEMA`. Tables: `papers`, `builds`, `conversations`, `highlights`, `glossary`, `prefs`, `events`. Plus a `papers_fts` FTS5 virtual table backing `/api/search`.
- `pdfs/` — local-only PDFs for `custom-*` imports (URL paste / upload). arXiv PDFs are streamed on demand from arxiv.org, not cached to disk.
- `runner.secret` + `runner.env` — runner bearer token (generated by `atlas start-runner`; the `.env` form is consumed by `docker-compose env_file`).

Paper IDs have two shapes: real arXiv IDs (auto-imported on first access via `_ensure_paper_imported` in `main.py`) and `custom-<sha>` IDs (synthetic, created by `imports.py` for URL/upload imports — these never touch arxiv.org).

### Background scheduler

`main.py::_daily_build_loop` ticks hourly while the backend runs:
1. Build today's digest if missing (arXiv fetch only, no AI ranking — fast + cheap)
2. Prune orphan PDFs (files with no row in `papers` pointing at them)
3. If `ATLAS_CHAT_RETENTION_DAYS` is set, prune old conversations (opt-in; off by default)

### Streaming protocol

Summarize / ask / build-progress endpoints use SSE. `main.py::_sse_format` JSON-encodes each chunk into the `data:` payload — do NOT emit raw text with newlines, the SSE parser treats `\n` as a field separator and would drop paragraph breaks. The frontend (`frontend/src/lib/sse.ts`) reverses this with `JSON.parse`.

### Frontend architecture

React 19 + Vite + TypeScript + Tailwind + Zustand. Entry in `frontend/src/main.tsx` — **note:** `<StrictMode>` is intentionally NOT used because its double-mount destroys the PDF.js worker mid-creation (known incompatibility).

Two routes:
- `/` — `IndexRoute` (paper list + greeting)
- `/reader/:arxivId` — `ReaderRoute` (PDF viewer + chat panel)

State is in `frontend/src/stores/ui-store.ts` (Zustand + `persist` middleware). Only visual prefs are persisted (see `partialize`); action dispatchers (`summarizeRequestId`, `askRequest`) are **ephemeral action-id counters** — subscribers react via `useEffect(..., [id])`. When adding a new cross-component action, follow the same incrementing-counter pattern rather than event buses.

Path alias: `@/…` → `frontend/src/…` (configured in `vite.config.ts` and `tsconfig.app.json`).

Tailwind palette is dynamic — `frontend/src/lib/theme.ts::applyPalette` writes CSS custom properties at the `:root` level, which is how the `ThemePicker` swaps the color scheme without reloading.

### Model allowlists (keep in sync)

If you add a new model, update BOTH sides:
- Backend: `backend/app/ai_argv.py::CLAUDE_MODELS` / `CODEX_MODELS`
- Frontend: `frontend/src/lib/api.ts::ModelChoice` / `CodexModel` types + the `CODEX_MODEL_META` / `CLAUDE_MODEL_META` tables in `ChatPanel.tsx`
- Default-model table: `backend/app/ai_backend.py::_DEFAULT_MODELS`

The `_normalize_model` function in `main.py` silently drops anything not in the allowlist and falls back to `_DEFAULT_MODELS` — so a typo will look like "the UI selection didn't take effect" rather than a 400.

## Design docs

Detailed design and implementation plans live under `docs/superpowers/`:
- `specs/2026-04-19-atlas-paper-reviewer-design.md` — original design
- `specs/2026-04-20-pdf-highlight-ask-and-docker-design.md` — PDF highlighting + docker-mode design
- `plans/` — execution plans that were followed to build each phase

Consult these when working on a feature rather than reinventing — they capture the rationale behind choices that are non-obvious from the code alone.
