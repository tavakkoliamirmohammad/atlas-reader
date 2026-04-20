# Atlas Plan 2 — Frontend Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working React + Vite + Tailwind + shadcn/ui frontend served by the FastAPI backend from Plan 1. After this plan ships, the user can open `http://localhost:8765` and: see today's arXiv papers grouped chronologically (no AI tiering yet), click a paper to open it in an embedded PDF reader, toggle Light/Sepia/Dark reading modes, switch between 6 accent themes, collapse the left and right side panels, and paste an arXiv URL to open any paper. The right panel shows a "Reader-only" CTA — chat and Summarize land in Plan 3.

**Architecture:** Vite-bundled React 18 SPA served at `/` by the existing FastAPI app. Vite dev server proxies `/api/*` to the backend on port 8765. Production build emits to `frontend/dist/` which FastAPI mounts via `StaticFiles`. State is plain React hooks plus a small Zustand store for UI prefs (theme, panel collapse, reading mode); routing via `react-router-dom`. PDF rendering uses `react-pdf` (PDF.js wrapper) with a Vite-bundled worker.

**Tech Stack:** Node 20+, Vite 5, React 18, TypeScript 5, TailwindCSS 3, shadcn/ui (latest), Zustand, react-router-dom 6, react-pdf 9 (PDF.js), Lucide icons. Tests: Vitest + @testing-library/react + jsdom + @testing-library/user-event. No AI integration in this plan.

---

## File Structure

```
paper-dashboard/
├── backend/
│   └── app/
│       └── main.py                ← MODIFIED: mount frontend/dist at /
├── frontend/
│   ├── package.json
│   ├── vite.config.ts             ← /api/* proxy + worker setup
│   ├── vitest.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── components.json            ← shadcn/ui config
│   ├── index.html
│   ├── public/
│   ├── dist/                      ← build output, gitignored, mounted by FastAPI
│   └── src/
│       ├── main.tsx               ← Router + theme bootstrap
│       ├── App.tsx                ← three-pane frame layout
│       ├── routes/
│       │   ├── IndexRoute.tsx
│       │   └── ReaderRoute.tsx
│       ├── components/
│       │   ├── TopBar.tsx
│       │   ├── ThemePicker.tsx
│       │   ├── PanelToggles.tsx
│       │   ├── AiStatusPill.tsx
│       │   ├── PaperList.tsx
│       │   ├── PaperRow.tsx
│       │   ├── UrlBar.tsx
│       │   ├── PaperReader.tsx
│       │   ├── PdfPage.tsx
│       │   ├── PdfToolbar.tsx
│       │   ├── PdfThumbsRail.tsx
│       │   ├── ReaderOnlyCta.tsx
│       │   ├── ReopenTab.tsx
│       │   ├── AuroraBackground.tsx
│       │   └── ui/                ← shadcn/ui generated components
│       ├── lib/
│       │   ├── api.ts             ← fetch wrappers around /api/*
│       │   ├── theme.ts           ← palette table + applyPalette()
│       │   ├── arxiv-id.ts        ← parse arXiv URLs/IDs
│       │   ├── pdf-worker.ts      ← PDF.js worker URL setup
│       │   ├── group-by-day.ts    ← chronological paper grouping
│       │   ├── keyboard.ts        ← global keyboard shortcut hook
│       │   └── utils.ts           ← cn() helper from shadcn
│       ├── stores/
│       │   └── ui-store.ts        ← Zustand store: theme, panels, reading mode
│       ├── styles/
│       │   └── globals.css        ← Tailwind + CSS custom props + aurora keyframes
│       └── test/
│           ├── setup.ts           ← Vitest + RTL + jsdom setup
│           └── test-utils.tsx     ← render-with-providers helper
```

**Responsibilities:**
- `lib/api.ts` is the only module that calls `fetch('/api/...')`
- `stores/ui-store.ts` owns persisted UI state; components read from it via hooks
- `lib/theme.ts` knows the 6 palettes and how to mutate `:root` CSS custom properties
- Components are dumb where possible; logic lives in `lib/` and `stores/`
- `App.tsx` only does layout; route components own data fetching for their pane

**Backend changes:** `backend/app/main.py` gets one new mount (`StaticFiles`) plus a SPA fallback route. No new routes added.

**Test coverage strategy:** TDD for modules with logic — `lib/arxiv-id.ts`, `lib/group-by-day.ts`, `lib/theme.ts`, `stores/ui-store.ts`, `lib/keyboard.ts`. Pure visual scaffolding (TopBar, AuroraBackground, ReaderOnlyCta) is built and committed without tests.

---

## Tasks

The full task content (~900 lines, 14 tasks) is captured in the original Plan 2 writer output. Each task has explicit Files (Create/Modify), bite-sized checkbox steps with complete code blocks, exact commands, and a commit message.

The plan covers, in order:

1. **Frontend bootstrap** — Vite + React + TS + Tailwind + shadcn init
2. **Mount frontend/dist from FastAPI** — `StaticFiles` + SPA fallback
3. **Vitest + RTL setup**
4. **Theme system** — palettes, store, `applyPalette()` (TDD)
5. **API client + arXiv ID parser** (TDD)
6. **Group-by-day helper** for paper list (TDD)
7. **Aurora background + globals styling**
8. **TopBar** — brand, theme picker, panel toggles, AI status pill
9. **Routing + three-pane frame layout**
10. **Paper list panel** — URL bar, day groups, paper rows
11. **PDF reader** — react-pdf integration, toolbar, thumbnails, Light/Sepia/Dark modes
12. **Reader-only CTA** for the right panel
13. **Keyboard shortcuts** (`[` / `]`) (TDD)
14. **End-to-end manual verification + atlas start integration** + README update

## Parallelization Notes

- After Task 4 (theme + store): Tasks 7 (Aurora), 8 (TopBar), 12 (Reader-only CTA) can run in parallel — pure visual scaffolding, no inter-dependencies
- After Task 9 (routing/frame): Tasks 10 (PaperList) and 11 (PdfReader) can run in parallel — independent files, placeholders already in place

## Deferred to Plan 3 / Plan 4

- AI features (Summarize, Ask, SSE chat, tier ranking, ProgressOverlay) → Plan 3
- Cmd+K command palette, J/K/S/?/g shortcuts, footer status bar, film-grain noise, vertical reading-progress rail, "fresh" pulse dots, reading-time estimate, hover-lift polish → Plan 4
- Text selection "Ask Claude" popover → depends on AI, Plan 3
- Backend `/api/theme` endpoint → not needed; localStorage via Zustand `persist` is sufficient

## Plan 2 Deliverables

After Plan 2 lands:
- React + Vite + TS + Tailwind + shadcn/ui frontend at `frontend/`
- FastAPI mounts `frontend/dist` at `/` with SPA fallback
- Three-pane glass layout: collapsible paper list (left) + PDF reader (center) + Reader-only CTA (right)
- Aurora background, 6 swappable accent themes, persisted via localStorage
- PDF reader with toolbar (prev/next, zoom, Light/Sepia/Dark) and thumbnail rail
- Chronological day-grouped paper list driven by `/api/digest`
- arXiv URL paste box that parses URLs/IDs and navigates to `/reader/:arxivId`
- Keyboard shortcuts `[` and `]` for panel toggles
- Vitest + RTL tests for all logic modules

**Note:** This file is a summary index. The full per-task instructions (with complete code blocks for every step) live in the original writer output and will be re-emitted task-by-task during dispatch. The first implementation dispatch will include the verbatim Task 1 content.
