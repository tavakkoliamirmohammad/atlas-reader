# Atlas

Local-first paper reviewer. Uses your own `codex` / `claude` CLI subscription — **$0 API cost**.

## One-time setup

```bash
git clone <repo> paper-dashboard && cd paper-dashboard
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e .                          # installs the `atlas` CLI
codex login                               # or: run `claude` once
cd frontend && pnpm install && cd ..
```

## Run

| Mode | Command | URL |
| --- | --- | --- |
| **Dev** (hot reload) | `atlas start-runner` + `cd frontend && pnpm dev` + `uvicorn app.main:app --reload --port 8765` | http://localhost:5173 |
| **Production** (local, Docker) | `atlas start-runner` then `docker compose up --build -d` | http://localhost:8765 |
| **Production** (hosted UI + local backend) | `atlas start` | hosted URL (see below) |

Stop everything: `docker compose down && atlas stop-runner` (or `atlas stop` if using non-Docker).

Status: `atlas status` · Logs: `docker compose logs -f atlas` + `atlas runner-logs`

## AI server only

The "AI runner" is the process that wraps your `codex` / `claude` CLI. Nothing else talks to those binaries.

```bash
atlas start-runner      # binds 127.0.0.1:8766, bearer-auth'd
atlas stop-runner
atlas runner-logs
```

## Hosted UI (invite-only, $0)

One deploy. Every invited user runs their own `atlas start` locally; the hosted page talks to *their* `localhost:8765`. No shared AI.

1. Push this repo to GitHub (private is fine).
2. **Cloudflare Pages** → Create project → connect repo
   - Build command: `cd frontend && pnpm install && pnpm build`
   - Build output: `frontend/dist`
3. **Cloudflare Access** → add an Access application over the Pages URL → policy: **Emails → include** your invite list. Free up to 50 users.
4. On the backend, set the hosted origin so CORS allows it:
   ```bash
   export ATLAS_CORS_ORIGINS="https://paper-dashboard.pages.dev"
   atlas start
   ```
5. Each invited user: install prerequisites above, run `atlas start`, open the hosted URL.

## Data

Everything under `~/.atlas/` (SQLite, PDFs, runner secret). Override with `ATLAS_DATA_DIR=/path`.

## Tests

```bash
pytest -q                                 # backend
cd frontend && pnpm test:run              # frontend
```
