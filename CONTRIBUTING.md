# Contributing

Thanks for considering a contribution. Atlas is a small project — bug reports, design discussion, and PRs are all welcome.

## Dev setup

```bash
git clone <your-fork> paper-dashboard && cd paper-dashboard
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cd frontend && pnpm install && cd ..
```

Install one of the AI CLIs locally (`codex` or `claude`) and sign in once — Atlas shells out to whichever is available.

## Running

```bash
atlas up                       # Docker: backend container + host runner
pnpm --dir frontend dev        # contributor dev: Vite on :5173, proxies /api → backend container
```

The Vite dev server honors `ATLAS_PORT`, so if you run `atlas up --port 9000`, start the dev server with `ATLAS_PORT=9000 pnpm --dir frontend dev`.

For backend-only hot reload (rare — usually you'd just restart the container), run `uvicorn app.main:app --reload --port 8765 --app-dir backend` against a stopped container.

## Tests

```bash
pytest -q                 # backend (171 tests)
pnpm --dir frontend test:run   # frontend (37 tests)
pnpm --dir frontend build      # typecheck + bundle
```

CI runs the same commands on every PR.

## Commit style

Conventional commits: `feat(area): ...`, `fix(area): ...`, `polish(area): ...`, `refactor(area): ...`. The area is the subsystem (`chat`, `pdf`, `digest`, `cli`, `brand`, etc.). First line ≤ 72 chars.

## PR checklist

- Tests pass (`pytest -q` + `pnpm test:run`).
- If the change touches the AI call path, re-read `backend/app/ai_argv.py` — the security flags there are load-bearing.
- If you add a new model, update all three sources listed under "Model allowlists" in `CLAUDE.md`.
- Commit messages explain the *why*, not just the *what*.

## Areas that welcome help

- Additional arXiv category tuning (beyond the current compilers/PL/MLIR defaults).
- Windows / Linux host runner parity (today's runner is macOS-tested only).
- Accessibility polish on the reader view.
- Offline-first improvements to the PDF cache.

See `CLAUDE.md` for codebase conventions and the two-process architecture overview.
