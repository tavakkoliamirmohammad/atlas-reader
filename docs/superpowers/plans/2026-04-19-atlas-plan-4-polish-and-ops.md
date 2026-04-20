# Atlas Plan 4 — Polish + Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After Plans 1-3, Atlas is functionally complete. Plan 4 makes it feel like a real product: keyboard shortcuts, Cmd+K command palette, motion polish, reading-progress rail, reading streak, launchd autostart, build-progress overlay, README finalization. Atlas v1 ships at the end of this plan.

**Architecture:** Backend adds a tiny `stats` module (counts unique paper opens per UTC day from a new `events` log), a build-progress SSE endpoint reusing the existing digest SSE plumbing, and a `launchd` plist generator. Frontend adds a global keyboard registry, a `cmdk`-based command palette, a reading-progress rail over PDF scroll, greeting + streak badge, footer status bar, build-progress overlay, and an animation polish pass that respects `prefers-reduced-motion`.

**Tech Stack:** Python 3.12 + FastAPI + sqlite3 (unchanged). Frontend adds **one** dependency: `cmdk`. Everything else reuses Plan 2's stack.

---

## Tasks

12 tasks total:

1. **Add `events` table + stats module** — schema migration, `stats.record_open(arxiv_id)`, `stats.papers_today()`, `stats.total_papers()`, `stats.streak_days()` (counts back from most recent day with events; allows "today empty if yesterday present"), `stats.summary()`
2. **`/api/stats` endpoint + event logging on paper open** — modify `GET /api/papers/{id}` to call `stats.record_open` on success (NOT on 404)
3. **Build-progress SSE endpoint** — `GET /api/build-progress?date=YYYY-MM-DD`; polls `builds.log` column, emits one SSE `data:` per new line + `event: done`/`event: failed` at terminal status
4. **Frontend keyboard shortcut registry** — `lib/keyboard.ts` global handler; `useShortcut(combo, handler)` hook; supports modifier (`mod+k`), single keys, and 800ms-window sequences (`g g`, `g p`); ignores when typing in input/textarea/contenteditable; `lib/motion.ts` sets `data-motion="on/off"` on `<html>` for CSS gating
5. **Shortcuts overlay (`?`)** — modal listing all shortcuts from the registry; Esc/backdrop closes
6. **Command palette (`Cmd+K`)** — `cmdk` library; fuzzy-search "Open paper..." (from `/api/digest`), "Switch theme...", "Toggle reading mode..."
7. **Greeting + Streak badge in TopBar** — time-of-day greeting ("Good morning, Amir · 3 fresh papers ready"); streak pill with flame icon ("🔥 14-day streak · 38 papers")
8. **Footer status bar** — "connected to Claude (subscription) · no API charges" + `?` `⌘K` `[` `]` shortcut hints
9. **Build-progress overlay** — full-screen overlay when digest is building; consumes `/api/build-progress` SSE; auto-dismisses on `event: done`
10. **Reading-progress rail** — vertical bar left of PDF; scroll progress fill (gradient); section markers from PDF.js outline (`pdf.getOutline()`); hover marker → tooltip with section title; wires `J`/`K` shortcuts
11. **Animation polish pass** — global CSS keyframes for `fadeUp`, `shimmer`, `aurora-drift`, `pulse-dot`, `hover-lift`, `magnetic`; gated on `html[data-motion="on"]`; applied across PaperList, ChatPanel, PaperReader, App grid
12. **launchd plist generator + CLI extras + README finalization** — `launchd.py` with `render_plist()`, `install()`, `uninstall()` (uses `launchctl bootstrap` / `bootout`); CLI subcommands `atlas install-launchd`, `atlas uninstall-launchd`, `atlas open` (atlas open already exists from Plan 1); finalize README with v1 status, full feature list, screenshot placeholders, full keyboard shortcut table, full endpoint list

## Plan 4 Deliverables

- Reading streak / stats / build progress backend
- Keyboard shortcut system (single keys, modifiers, sequences)
- Cmd+K command palette
- Shortcuts overlay
- Greeting + Streak in TopBar; Footer status bar
- Build-progress overlay
- Reading-progress rail with PDF outline markers
- Full motion polish pass with `prefers-reduced-motion` guard
- launchd autostart + CLI install/uninstall
- README finalized for v1

## Speculative Items Deferred

- **Hover tooltips on technical terms (LLM explainers)** — would require per-paper term extraction + PDF.js text-layer annotations. Could be a Plan 5 or focused follow-up.

## Atlas v1

After this plan lands, Atlas v1 is complete: a polished local-first paper reviewer with daily AI-tiered digest, on-demand summaries, chat Q&A, modern dark UI, and autostart on login.

Implementer dispatch must include full per-task content from the original Plan 4 writer output (kept in conversation history; HTML entities decoded inline).
