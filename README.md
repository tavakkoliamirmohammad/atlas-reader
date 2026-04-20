# Atlas

Local-first paper reviewer. Browses arXiv papers, summarizes on-demand using your Claude subscription. Runs entirely on your Mac.

## Status

**Plan 2 — Frontend shell: complete.** Open `http://localhost:8765` after `atlas start` for the full reader. AI features (Summarize, Ask, tier ranking) land in Plan 3.

## Frontend

```bash
cd frontend
pnpm install
pnpm dev          # dev server on :5173 with API proxy to :8765
pnpm build        # emits to frontend/dist/, served by FastAPI at /
pnpm test         # vitest in watch mode
```

## Setup

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Running the dev server

```bash
atlas start          # http://localhost:8765
atlas status
atlas logs
atlas stop
```

## Endpoints (Plan 1)

- `GET /api/health` — `{ai, papers_today}`
- `GET /api/digest?build=true` — fetch today's arXiv papers and persist
- `GET /api/digest` — return persisted papers (no fetch)
- `GET /api/papers/{arxiv_id}` — single paper metadata
- `GET /api/pdf/{arxiv_id}` — cached PDF (downloads from arXiv on first request)

## Tests

```bash
pytest -v
```

## Data location

`~/.atlas/atlas.db` and `~/.atlas/pdfs/`. Override with `ATLAS_DATA_DIR=/some/path`.
