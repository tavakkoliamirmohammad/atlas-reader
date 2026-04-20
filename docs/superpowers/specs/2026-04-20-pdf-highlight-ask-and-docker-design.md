# PDF Highlighting + Ask, and Docker packaging

**Date:** 2026-04-20
**Status:** Approved
**Scope:** One plan. Covers the missing in-PDF highlight UX, the "Ask about this" flow, and dockerizing the app.

## Goal

Let the user select text in the rendered PDF, see a floating toolbar with two actions:

- **Highlight** — draws a persistent colored overlay on the page (reappears on reopen).
- **Ask** — sends the quote to the chat panel as a pinned quote chip; the user types a question that gets prepended with the quote.

Also: package the app as a single-container Docker image + compose file, so it can be spun up with one command.

## Non-goals

- Note-taking on highlights (the `note` column already exists; UI stays out of scope for this plan).
- Cross-paper highlight search.
- Highlight editing (color change, resize). Delete-only, like today.
- Running `claude -p` (Claude CLI) inside the container. The Claude subprocess requires the user's local subscription; AI features are expected to be disabled in-container and documented as such.

## Architecture

### Frontend

- **`PdfViewport`**
  - Render pdf.js `TextLayer` over each page canvas (transparent, absolutely positioned, same lifecycle as the canvas). This gives native browser text selection across the PDF.
  - On `selectionchange`, walk the live `Selection`'s client rects, map each rect through the owning page's `pageViewport.convertToPdfPoint()` to normalized `[0,1]` coords relative to page width/height, and fire the existing `onSelection({text, page, rects})` callback. `null` when the selection is cleared.
  - The existing `highlights?: HighlightWithPosition[]` prop and overlay renderer stay unchanged.

- **`PdfPage`**
  - Owns `selection: SelectionPayload | null` (from `onSelection`).
  - Renders a new `SelectionToolbar` component absolutely positioned just above the last selection rect, clamped inside the viewport. Buttons: **Highlight** (color swatch cycles yellow → coral → blue) and **Ask** (message icon).
  - Click outside or `Escape` clears selection and hides the toolbar.

- **`HighlightsPanel`**
  - Fetched highlights are lifted up to `PaperReader` and passed to `PdfViewport` as `highlights` so the overlay and the side-panel list stay in sync.
  - Each panel row gains a jump affordance: clicking the row calls `jumpRef.current?.(h.page)` to scroll to that page.
  - Existing clipboard-paste flow stays as a fallback for the "I already copied a quote" case.

- **`ChatPanel`**
  - New prop `pinnedQuote: {text, page} | null` + `onClearPinnedQuote()`.
  - When a pinned quote exists, renders a dismissible blockquote chip above the input. On submit, the quote is prepended to the user message as `> {quote}\n\n{question}`, then cleared.

- **`ui-store.ts`**
  - Add `pinnedQuote: {text: string, page: number} | null` + `setPinnedQuote` + `clearPinnedQuote`.
  - Add `lastHighlightColor: HighlightColor` (defaults to `"yellow"`), set whenever the user picks a color in either the panel or the toolbar.

### Backend

- **`highlights` table**
  - Add column `rects TEXT` (JSON-encoded `SelectionRect[]`, nullable).
  - `page INTEGER` already exists; stays nullable so old clipboard-only rows keep working.
  - Migration lives in `db.init()`: check `PRAGMA table_info(highlights)`, add `rects` if missing. Idempotent on every startup.

- **`highlights.py`**
  - `add(arxiv_id, quote, color, page, note, rects)` — `rects` is `List[dict] | None`, JSON-serialized on insert.
  - `list_for(arxiv_id)` — deserializes `rects` back to a list before returning (still `sqlite3.Row`-compatible at the route layer).

- **`main.py` routes**
  - `POST /api/highlights/{arxiv_id}` body gains `rects: list[SelectionRect] | None = None` and `page: int | None = None`.
  - `GET /api/highlights/{arxiv_id}` returns parsed `rects` in each row dict.
  - `DELETE /api/highlights/{highlight_id}` unchanged.

### Data flow

```
user drags across PDF text
   → Selection on TextLayer spans (native browser)
   → selectionchange handler in PdfViewport
   → compute normalized rects per page
   → onSelection({text, page, rects})
      → PdfPage sets selection state, shows SelectionToolbar
         ├── Highlight: POST /api/highlights → optimistic prepend in panel list
         │              → PdfViewport re-renders overlay from updated `highlights` prop
         └── Ask:       setPinnedQuote({text, page}) → focus chat input
                         → on send, prepend `> {quote}\n\n{question}` to user message
```

## Docker

### Image

Two-stage `Dockerfile` at repo root:

1. **frontend-build** (`node:20-alpine`): `pnpm install --frozen-lockfile && pnpm build` → outputs `frontend/dist`.
2. **runtime** (`python:3.12-slim`):
   - `pip install -e ".[dev]"`
   - copy `backend/` + `frontend/dist/` (served from FastAPI static mount)
   - `ENV ATLAS_DATA_DIR=/data`
   - `EXPOSE 8765`
   - `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765"]`

### Compose

`docker-compose.yml`:
- One service, image built from the Dockerfile.
- Volume `./atlas-data:/data` so SQLite + logs persist across restarts.
- Port `8765:8765`.
- `ATLAS_DATA_DIR=/data`.

### Claude CLI caveat

`claude -p` needs the user's local Claude CLI + subscription. Inside the container, AI endpoints will respond with `ai: false` (digest build still works because ranker is AI-optional). The README gets a short Docker section documenting this; local `atlas up` remains the way to use AI features.

## Testing

**Backend**
- `test_highlights_migration.py` — `db.init()` is idempotent; `rects` column is present; rows round-trip with a list of dicts.
- Extend `test_main.py` highlight route tests to cover `rects` + `page` in request/response.

**Frontend**
- `PdfViewport.test.tsx` — selection → rects math: mock a `Selection` with known client rects and a known page viewport, assert normalized output.
- `ChatPanel.test.tsx` — `pinnedQuote` renders the chip, submit prepends the quote, submit clears the chip.
- `HighlightsPanel.test.tsx` — jump action calls the provided `onJump` with the row's `page`.

**Manual smoke (post-dockerize)**
- `docker compose up --build` → open http://localhost:8765 → digest loads → open a paper → highlight text → overlay shows → reload → overlay still there → Ask about this → chip shows in chat → submit sends quote-prefixed message.

## Open risks

- **Text-layer performance** on big PDFs: we already virtualize canvases; the text layer has to follow the same visible-range rendering to avoid rendering N thousand spans. Mitigation: hook into the same LRU as canvases (same `renderedSetRef`), render the text layer inside the same page render path.
- **Selection across virtualized pages**: if a selection spans pages that haven't been text-layered yet, the cross-page rects may be incomplete until those pages render. Acceptable — the user can scroll first, then select. Document in commit.
- **Sepia/dark filter on text layer**: the text layer is transparent, but any child rects might show the CSS `filter:` at the container level. Since highlight overlays already sit inside the filtered container and look right, no extra handling needed.

## Build order

1. Backend: `rects` column + migration + route/body updates + tests.
2. `PdfViewport`: text-layer rendering + selection → normalized rects + `onSelection` wired.
3. `PdfPage`: `SelectionToolbar` + selection state + Highlight/Ask dispatch.
4. Lift highlights up to `PaperReader`; pass to both `PdfViewport` and `HighlightsPanel`.
5. `ChatPanel` pinned-quote chip + store slice.
6. `HighlightsPanel` jump-to-page.
7. `Dockerfile` + `docker-compose.yml` + README section.
8. Manual smoke.
