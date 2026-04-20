# Atlas Plan 3 — AI Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Layer AI features on Plans 1+2. After this plan: digest is tier-ranked by Haiku, **Summarize** streams a 10-section deep summary from Opus, **Ask Claude** streams a chat answer from Sonnet, conversations persist per-paper, and the no-AI fallback continues to work.

**Architecture:** Every AI call goes through a `claude -p` subprocess (never the Anthropic API directly). A small async wrapper (`claude_subprocess.py`) yields stdout chunks; ranker / summarizer / asker build on it. SSE via `fastapi.responses.StreamingResponse`. Frontend consumes with `fetch + ReadableStream` (POST + SSE needs this; native `EventSource` is GET-only). Concurrency capped at 4 via `asyncio.Semaphore`.

**Tech Stack:** Python 3.12 + FastAPI + sqlite3 + pytest-asyncio (backend); React + Vite + Tailwind + shadcn/ui (frontend, from Plan 2). New: `asyncio.create_subprocess_exec`. No new pip or npm deps.

---

## Tasks

14 tasks total:

1. **`claude_subprocess.py`** — async streaming wrapper, `MAX_CONCURRENT=4` semaphore, `ClaudeSubprocessError` exception, `run_streaming(args, stdin_text)` async generator
2. **Prompt files** — `prompts/ranker.txt` (1-5 scoring with research interests baked in), `prompts/summary_template.txt` (10-section template), `prompts/chat_system.txt` (PhD-level technical system prompt)
3. **Ranker module** — `score_papers(items)` calls Haiku, parses JSON `[{"id","score"},...]`, writes `ai_tier`/`ai_score` to papers table; tolerates malformed JSON
4. **Wire ranker into `digest.build_today()`** — calls `ranker.score_papers` after upsert when `health.claude_available()`; never blocks on AI failure
5. **Conversations repository** — `append(arxiv_id, role, content)` + `history(arxiv_id)`, only module touching the conversations table
6. **Summarizer module** — `async summarize(arxiv_id)` yields chunks; uses Opus + `--effort max` + `--allowedTools Read`; raises `KeyError` for missing papers
7. **Asker module** — `async ask(arxiv_id, question, history)` yields chunks; uses Sonnet; persists user message up-front and assistant message after stream completes (NOT on subprocess failure)
8. **SSE endpoints in main.py** — `POST /api/summarize/{id}`, `POST /api/ask/{id}` (body `{question, history}`), `GET /api/conversations/{id}`; SSE format `data: <chunk>\n\n` plus `event: done` / `event: error`
9. **Frontend SSE helper + bindings** — `streamSSE(url, init, handlers, signal)` using `fetch + ReadableStream`; `streamSummary`, `streamAsk`, `fetchConversations` in `lib/api.ts`
10. **Tier-aware paper list** — when `aiOn`: group A (≥4) / B (2-3) / C (1) with 🔥/⭐/📄; when off: group by date
11. **`StreamingMessage` + ChatPanel composer** — message bubble that appends chunks live; chat panel with composer, conversation history fetch on mount, abort controller for cancel
12. **`QuickActionChips`** — Summarize (primary, shimmer animation) + Key contributions / Compare to prior work / Open questions / Reproduce setup quick-prompts
13. **End-to-end AI integration test** — full round-trip: digest with ranking → summarize SSE → ask SSE → conversation persistence
14. **Manual smoke + README update** — `atlas start`, `curl /api/digest?build=true`, verify `ai_tier` set, stream a summary; update README with AI endpoints section

## Plan 3 Deliverables

- Three new backend modules (claude_subprocess, ranker, summarizer, asker, conversations)
- Three new SSE/HTTP endpoints
- Frontend SSE consumer + tier-aware list + chat composer + quick action chips
- AI gracefully degrades to Reader-only at every layer

## Plan 3 Key Constraints

- All AI through `claude -p` subprocess; $0 cash cost (subscription quota only)
- TDD for backend modules; mock at `subprocess` boundary
- Concurrency cap: 4 concurrent claude invocations
- Conversation persistence: write user msg up-front, assistant msg only after stream succeeds
- Implementer dispatch must include full per-task content from the original Plan 3 writer output (kept in conversation history; HTML entities decoded inline)
