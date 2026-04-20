# Atlas — Personal Paper Reviewer

**Date:** 2026-04-19
**Owner:** Amir
**Status:** Design (approved during brainstorming)

## 1. Overview

Atlas is a local-first web app for reading research papers. It does two things:

1. **Daily arXiv digest** — fetches recent papers in the user's research areas (compilers, MLIR, DSLs, tensor compilers, code generation), ranks them by relevance with a tiered system (🔥 must-read / ⭐ worth-knowing / 📄 peripheral), and presents the day's reading list.
2. **Paper reader** — embedded PDF viewer with on-demand AI features: summarize the paper using a structured 10-section template, ask follow-up questions about the paper, and run quick actions (key contributions, compare to prior work, open questions, reproduce setup).

It runs entirely on the user's Mac. A long-lived FastAPI server hosts the React frontend; AI features call the local `claude -p` CLI subprocess against the user's Claude Pro/Max subscription. **No money is charged** beyond the subscription the user already pays for, and **no separate API key is needed**.

## 2. Goals

- One web app where the user reads papers, with daily digest as the entry point and ad-hoc URL paste as the secondary entry point
- AI features feel native and on-demand (not pre-baked in a batch)
- $0 incremental cost — uses the user's Claude subscription via `claude -p`
- Works offline-ish: PDF viewer, arXiv fetch, browsing, and reading work even when Claude is unavailable
- Distinctive, modern UI that the user actually wants to open every day
- Theme switching: 6 accent palettes the user can swap live

## 3. Non-goals (v1)

- **No LLVM commit feed** (kept on existing local launchd script)
- **No conference deadlines feed** (kept on existing local launchd script)
- **No gym hours** (kept on existing local launchd script)
- **No authentication / multi-user.** Single user, local-only.
- **No hosted/cloud version.** GitHub Pages is static-only and can't host the FastAPI backend. Future hosted variant is out of scope but the architecture leaves the door open.
- **No Slack output** (the prior bot identity issue and migration plan are documented separately)
- **No payments / API keys.** All AI calls go through the local `claude -p` subscription path.

## 4. User stories

1. *Morning ritual.* I open Atlas in my browser. The daily digest is fresh (or starts building with a live progress page). I scan the must-read tier, click the top paper.
2. *Deep read.* The paper opens in the embedded PDF viewer. I tap **Summarize**; a structured 10-section analysis streams into the right panel. I ask a follow-up: "How does it handle differing memory models?" The answer streams in.
3. *Ad-hoc paper.* A colleague sends an arXiv link. I paste it into the URL input at the top of the paper list. The reader opens with the same Summarize / Ask features.
4. *Focus mode.* I want to actually read without distractions. I collapse both side panels with `[` and `]`. The PDF goes fullscreen. I switch reading mode to Sepia for a long session, or Dark when reading at night.
5. *Subscription lapses.* My Claude subscription temporarily isn't connected. Atlas detects this on startup; tier badges become date groups, the chat panel becomes a "Connect Claude" CTA, and the rest of the app keeps working.
6. *Mood change.* I'm tired of cyan accents. I click a different theme dot in the topbar; the whole UI re-skins with a smooth transition.

## 5. Architecture

```
┌──────────────────────────── Mac (localhost) ────────────────────────────┐
│                                                                          │
│   launchd (KeepAlive=true, RunAtLoad=true)                               │
│        │                                                                 │
│        ▼                                                                 │
│   uvicorn → FastAPI app (port 8765)                                      │
│        │                                                                 │
│        ├── serves React static bundle at /                               │
│        ├── /api/digest        ← daily build endpoint (SSE for progress) │
│        ├── /api/papers/{id}   ← paper metadata + cached fields          │
│        ├── /api/pdf/{id}      ← proxies arXiv PDF (cached locally)      │
│        ├── /api/summarize/{id}     ← SSE stream from `claude -p`        │
│        ├── /api/ask/{id}           ← SSE stream from `claude -p`        │
│        ├── /api/health             ← AI availability + build state      │
│        └── /api/theme              ← persisted theme preference          │
│                                                                          │
│   SQLite (~/.atlas/atlas.db)                                             │
│        ├── papers (cached arXiv metadata + AI tier + read state)         │
│        ├── builds (per-day build status + log)                           │
│        ├── conversations (per-paper chat history)                        │
│        └── prefs (theme, reading mode, last-opened paper, etc.)          │
│                                                                          │
│   PDF cache (~/.atlas/pdfs/{arxiv_id}.pdf)                               │
│                                                                          │
│   `claude -p` subprocess pool (max 4 concurrent)                         │
│        ↑                                                                 │
│   Anthropic OAuth (user's Pro/Max subscription)                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The browser polls `/api/health` on load. If it shows `ai: connected`, AI features render. If `ai: disconnected`, the app boots into Reader-only mode.

## 6. Components

### 6.1 Backend (Python · FastAPI)

- `app/main.py` — FastAPI bootstrap, CORS for `localhost`, mount static React bundle, wire routes
- `app/digest.py` — arXiv fetch (cs.PL all + cs.AR/cs.DC keyword filter), dedupe, run AI tiering if available, write to SQLite
- `app/ranker.py` — given a list of papers, ask `claude -p --model haiku` to score each 1–5 by relevance to user's research interests (compilers, MLIR, DSLs, tensor compilers, code generation, polyhedral compilation, hardware synthesis — sourced from `app/prompts/ranker.txt`); tier into A (4–5) / B (2–3) / C (1)
- `app/summarizer.py` — given a paper id, fetch the cached PDF, call `claude -p --model opus` with the 10-section template stored in `app/prompts/summary_template.txt` (background, problem & motivation, key contribution, method, evaluation, key figures, strengths, limitations, follow-up directions, key references — same template as the existing `~/.claude/compiler-papers.sh`), stream the response via SSE
- `app/asker.py` — given a paper id and a question, call `claude -p --model sonnet` with the PDF + chat history, stream via SSE. Persists conversation in SQLite
- `app/pdf_proxy.py` — fetches `https://arxiv.org/pdf/{id}` once, caches to `~/.atlas/pdfs/`, serves to the frontend
- `app/health.py` — checks `claude --version` and a quick `claude -p --max-budget-usd 0.01 echo` to verify subscription is live; returns `{ai: bool, last_build: timestamp, papers_today: int}`
- `app/db.py` — SQLite schema + thin query layer (no ORM; raw SQL via `sqlite3`)
- `app/launchd.plist` — generated plist to put in `~/Library/LaunchAgents/com.amir.atlas.plist`

### 6.2 Frontend (React + Vite + Tailwind + shadcn/ui)

- `src/App.tsx` — top-level layout: topbar + 3-column frame
- `src/components/TopBar.tsx` — brand, theme picker, panel toggles, AI status pill
- `src/components/PaperList.tsx` — left panel; URL input at top, tiered groups, paper rows
- `src/components/PaperReader.tsx` — center; thumbnails rail + floating toolbar + `<PdfPage />`
- `src/components/PdfPage.tsx` — wraps `react-pdf` (PDF.js); applies Light/Sepia/Dark mode; exposes text-selection for the "Ask Claude" popover
- `src/components/ChatPanel.tsx` — right panel; quick-action chips, message stream, composer; shows `<ReaderOnlyCTA />` when AI is off
- `src/components/ProgressOverlay.tsx` — full-screen build-in-progress UI with SSE log
- `src/lib/sse.ts` — small SSE client wrapper
- `src/lib/theme.ts` — applies CSS custom properties (`--ac1`, `--ac2`, etc.) on theme change; persists to `/api/theme`
- `src/lib/keyboard.ts` — `[` / `]` to toggle panels, `J` / `K` for next/prev page, `S` for summarize, `/` for search, `?` for shortcut help

### 6.3 Process management

- `launchctl load ~/Library/LaunchAgents/com.amir.atlas.plist` keeps `uvicorn` alive across reboots and login sessions
- A small `atlas` CLI command (Python entry point) supports `atlas start`, `atlas stop`, `atlas status`, `atlas open` (opens browser), `atlas logs`

## 7. Key sequences

### 7.1 Open the app in the morning

1. User opens `http://localhost:8765` in browser
2. Frontend loads, calls `/api/health` and `/api/digest?date=today`
3. If today's digest is built → render immediately
4. If not built → render `<ProgressOverlay />`, open SSE to `/api/digest?build=true`
5. Backend streams: `fetching arxiv... → 137 papers → ranking with Sonnet... → tiered: 3 must / 8 worth / 12 peripheral → done`
6. Frontend transitions out of the overlay and into the digest view

### 7.2 Click a paper → open reader

1. User clicks a paper row → frontend calls `/api/papers/{id}`
2. Backend returns metadata; frontend mounts `<PaperReader />`
3. `<PdfPage />` requests `/api/pdf/{id}`; backend serves cached PDF or fetches from arXiv first
4. PDF.js renders to canvas with TextLayer overlay for selection
5. User taps **Summarize** chip → frontend opens SSE to `/api/summarize/{id}`
6. Backend invokes `claude -p --model opus --effort max --max-budget-usd 2 --allowedTools Read` with the 10-section template prompt + the cached PDF path
7. Each chunk of `claude -p` stdout is streamed back as an SSE event; frontend appends to the chat panel as a single growing "Summary" message

### 7.3 No-AI startup

1. Server starts; `health.py` runs `claude -p` smoke test → fails or times out
2. `/api/health` returns `{ai: false}`
3. Frontend renders Reader-only mode: tier badges become date groupings, Summarize chips hide, chat panel becomes `<ReaderOnlyCTA />`
4. PDF viewer, arXiv fetching (without ranking), URL paste, browsing all work normally

### 7.4 Theme change

1. User clicks a theme dot → `theme.ts` sets CSS custom properties on `:root`
2. Frontend POSTs `/api/theme` with `{c1, c2, ink}` for persistence
3. On next page load, `/api/theme` returns the saved palette and frontend applies it before first paint

## 8. Data model (SQLite)

```sql
CREATE TABLE papers (
  arxiv_id     TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  authors      TEXT NOT NULL,        -- comma-joined
  abstract     TEXT NOT NULL,
  categories   TEXT NOT NULL,        -- comma-joined
  published    TEXT NOT NULL,        -- ISO date
  pdf_path     TEXT,                 -- nullable until cached
  ai_tier      INTEGER,              -- 1..5, NULL if not yet ranked
  ai_score     REAL,                 -- raw model score, NULL if not ranked
  read_state   TEXT DEFAULT 'unread' -- unread | reading | read
);

CREATE TABLE builds (
  date         TEXT PRIMARY KEY,     -- YYYY-MM-DD
  status       TEXT NOT NULL,        -- pending | building | done | failed
  started_at   TEXT,
  finished_at  TEXT,
  paper_count  INTEGER,
  log          TEXT                  -- newline-joined progress events
);

CREATE TABLE conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  arxiv_id     TEXT NOT NULL REFERENCES papers(arxiv_id),
  role         TEXT NOT NULL,        -- user | assistant | system
  content      TEXT NOT NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE prefs (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL
);
-- prefs rows: 'theme' = '{"c1":"#22d3ee","c2":"#10b981","ink":"#06121a"}'
--             'reading_mode' = 'light' | 'sepia' | 'dark'
--             'last_paper' = '<arxiv_id>'
--             'left_collapsed' = 'true' | 'false'
--             'right_collapsed' = 'true' | 'false'
```

## 9. AI integration details

- **All AI calls are subprocess invocations of `claude -p`**, never the API directly. The user's Pro/Max OAuth handles auth.
- **Models:**
  - **Haiku** for tier ranking (fast, cheap on quota; only ranks ~30 papers/day)
  - **Sonnet** for chat (Q&A; conversational, balanced)
  - **Opus** with `--effort max` for the 10-section deep summary (highest quality, only when user explicitly clicks Summarize)
- **Concurrency cap:** at most 4 concurrent `claude -p` subprocesses (matches the existing `compiler-papers.sh` pattern)
- **Streaming:** every `claude -p` call uses subprocess pipes; backend reads stdout line-by-line and forwards as SSE events
- **Failure modes:** if `claude -p` exits non-zero, error is surfaced to the frontend with a "Retry" button. If the smoke test fails on startup, app boots into Reader-only mode for the rest of the session (re-checks every 5 minutes)
- **Cost guardrail:** keep `--max-budget-usd 2` on the Opus summary call as a safety stop (no real money; subscription quota guardrail)

## 10. Visual design system

- **Aesthetic:** modern dark with glass panels, aurora background, glow accents
- **Type:** Inter for UI, JetBrains Mono for arXiv IDs and code, Charter / Iowan Old Style for the rendered PDF page (when not in PDF mode the chrome is sans)
- **Themes (6 palettes):**
  - Cyan / emerald (default): `#22d3ee` → `#10b981`
  - Emerald / teal: `#10b981` → `#14b8a6`
  - Sky / indigo: `#38bdf8` → `#6366f1`
  - Amber / orange: `#fbbf24` → `#f97316`
  - Lime / emerald: `#a3e635` → `#10b981`
  - Mono / arctic: `#e2e8f0` → `#94a3b8`
  - Tier colors (rose/amber/slate) stay constant across themes — they're semantic
- **Reading modes for PDF page:** Light (`#fafafa`/`#111`), Sepia (`#f4ead4`/`#2a1f10`), Dark (`#15161b`/`#e9e9ed`). Dark mode applies CSS `filter: invert(1) hue-rotate(180deg)` to the PDF canvas; per-paper override in case figures invert badly
- **Motion:** fade-up entrance on PDF page and chat messages, hover-lift on chips and paper rows, slow aurora drift, pulse on fresh-paper dots, shimmer sweep on the primary Summarize chip, smooth grid transition on panel collapse
- **Layout:** 3-column grid (paper list / PDF / chat). Either side panel can collapse to 0 width via toggle in topbar or chevron handle on the panel edge. Reopen tabs appear on the edge when collapsed
- **Distinctive details:** subtle film-grain noise overlay, vertical reading-progress rail on the PDF with section markers, command-palette `⌘K` hint in topbar, "fresh" pulse dots on new papers, reading-time estimate per paper, "online" + typing indicator in chat, footer status bar with subscription confirmation

## 11. Folder layout

```
paper-dashboard/
├── README.md
├── pyproject.toml             # backend deps + atlas CLI entry point
├── backend/
│   └── app/
│       ├── main.py
│       ├── digest.py
│       ├── ranker.py
│       ├── summarizer.py
│       ├── asker.py
│       ├── pdf_proxy.py
│       ├── health.py
│       ├── db.py
│       ├── prompts/
│       │   ├── ranker.txt
│       │   ├── summary_template.txt
│       │   └── chat_system.txt
│       └── launchd.plist.template
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── components/
│       │   ├── TopBar.tsx
│       │   ├── PaperList.tsx
│       │   ├── PaperReader.tsx
│       │   ├── PdfPage.tsx
│       │   ├── ChatPanel.tsx
│       │   ├── ProgressOverlay.tsx
│       │   └── ReaderOnlyCTA.tsx
│       ├── lib/
│       │   ├── sse.ts
│       │   ├── theme.ts
│       │   ├── keyboard.ts
│       │   └── api.ts
│       └── styles/
│           └── globals.css
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-04-19-atlas-paper-reviewer-design.md   ← this file
└── data/                       # ~/.atlas/ gets symlinked here in dev
    ├── atlas.db
    └── pdfs/
```

## 12. Open questions / future work

- **Mobile read.** Static frontend on GitHub Pages + serverless backend on Cloudflare Workers would let the user read on phone. Not in v1.
- **Annotations.** Highlights and notes per paper, persisted in SQLite. Could expose as a 4th panel or overlay.
- **Cross-paper search.** Once enough papers are cached, full-text search across stored abstracts + summaries.
- **Authentication.** Only relevant if the app is ever hosted; v1 is single-user local.
- **mupdf.js fallback.** If PDF.js mangles a paper's rendering, allow a per-paper switch to mupdf.js.
- **Custom theme palettes.** Beyond the 6 presets, allow the user to define their own (color picker, persisted).
- **Reading streak / stats panel.** The mockup shows a "14-day streak" badge; actual logic for what counts as "read" needs definition.
- **Multi-conversation per paper.** Currently a single chat thread per paper. Tabs for multiple conversations could come later.

## 13. Cost / hosting summary

- **Recurring cost: $0.** Uses the Claude Pro/Max subscription the user already pays for via `claude -p` subprocess.
- **Hosting cost: $0.** Local-only; FastAPI on `localhost:8765`.
- **Subscription quota note.** Heavy usage (multiple summaries + active chat) consumes subscription rate limits and can throttle other Claude Code work for a few hours. Tier ranking uses Haiku (cheap), summaries use Opus (expensive but on-demand only).
