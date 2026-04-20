# PDF Highlight + Ask + Docker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn text selection in the PDF reader into two actions — persistent colored highlights on the page, and "Ask about this" which pins the quote into the chat panel. Also package the app as a Docker image + compose file.

**Architecture:** The PDF viewer already renders a pdf.js text layer and exposes an `onSelection({text, page, rects})` callback (lines 494-548 of `PdfViewport.tsx`) and a `highlights: HighlightWithPosition[]` prop that draws normalized overlay rects (lines 635-669). The work is (a) persisting rects in the DB, (b) lifting highlight state up to `PaperReader` and fanning it out, (c) a `SelectionToolbar` that dispatches either Highlight (POST + overlay) or Ask (pin quote in chat), and (d) a Dockerfile + compose for single-command spin-up.

**Tech Stack:** FastAPI + SQLite (backend), React 19 + Vite + Zustand + pdf.js 5 (frontend), Docker + docker-compose.

Spec: `docs/superpowers/specs/2026-04-20-pdf-highlight-ask-and-docker-design.md`

---

## File Structure

**New files**
- `frontend/src/components/SelectionToolbar.tsx` — floating 2-button toolbar rendered near a selection's last rect.
- `frontend/src/components/SelectionToolbar.test.tsx` — unit tests for the toolbar.
- `backend/tests/test_highlights_rects.py` — rects round-trip + migration idempotency.
- `Dockerfile` — two-stage (frontend build → python runtime).
- `docker-compose.yml` — one service, volume mount for data.
- `.dockerignore` — keep the build context small.

**Modified files**
- `backend/app/db.py` — add `rects TEXT` to the highlights table; in-place migration in `init()`.
- `backend/app/highlights.py` — accept/return `rects` as a Python list (JSON in the column).
- `backend/app/main.py` — extend `HighlightBody` with `rects`; pass through; include `rects` in row dict.
- `frontend/src/lib/api.ts` — extend `Highlight` + `createHighlight` with `rects` + `page`.
- `frontend/src/stores/ui-store.ts` — add `pinnedQuote` state + setter/clearer; add `lastHighlightColor`.
- `frontend/src/components/PaperReader.tsx` — fetch + own `highlights[]`, pass to `PdfPage`; pass `onSelection` handler.
- `frontend/src/components/PdfPage.tsx` — receive highlights + selection props, render `SelectionToolbar`, forward to `PdfViewport`.
- `frontend/src/components/HighlightsPanel.tsx` — receive highlights as prop (lifted up) + `onJump` prop; click row → jump; after create/delete, call parent refetch.
- `frontend/src/components/ChatPanel.tsx` — render pinned-quote chip from store; prepend quote to message on send.
- `frontend/src/components/RightPanel.tsx` — if it renders `HighlightsPanel`, pass the lifted props through or drop its internal state (see Task 3).
- `README.md` — add Docker section with the `claude -p` caveat.

---

## Task 1: Backend — add `rects` column and migration

**Files:**
- Modify: `backend/app/db.py`
- Test: `backend/tests/test_highlights_rects.py` (new)

- [ ] **Step 1: Write the failing migration test**

Create `backend/tests/test_highlights_rects.py`:

```python
"""Tests for the rects column on highlights (added 2026-04-20)."""

import json
import sqlite3

from app import db


def test_init_adds_rects_column_if_missing(atlas_data_dir):
    # Create an old-shape highlights table without rects, like a pre-migration DB.
    with sqlite3.connect(db.db_path()) as conn:
        conn.execute(
            """CREATE TABLE highlights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                arxiv_id TEXT NOT NULL,
                quote TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT 'yellow',
                page INTEGER,
                note TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        conn.execute(
            "INSERT INTO highlights (arxiv_id, quote) VALUES (?, ?)",
            ("preexist", "old row"),
        )

    # Now run init — it should add the rects column without nuking the row.
    db.init()

    with sqlite3.connect(db.db_path()) as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(highlights)")}
        assert "rects" in cols

        cur = conn.execute("SELECT quote, rects FROM highlights WHERE arxiv_id='preexist'")
        row = cur.fetchone()
        assert row is not None
        assert row[0] == "old row"
        assert row[1] is None  # backfilled NULL on old rows


def test_init_is_idempotent_on_fresh_db(atlas_data_dir):
    db.init()
    db.init()  # second call must not raise "duplicate column name"
    with sqlite3.connect(db.db_path()) as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(highlights)")}
        assert "rects" in cols
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest backend/tests/test_highlights_rects.py -v`
Expected: `test_init_adds_rects_column_if_missing` FAILS with `assert "rects" in cols`.

- [ ] **Step 3: Add `rects` to the SCHEMA and migration logic**

In `backend/app/db.py`, update the `highlights` CREATE TABLE in `SCHEMA` (around line 53) to:

```sql
CREATE TABLE IF NOT EXISTS highlights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    arxiv_id    TEXT NOT NULL REFERENCES papers(arxiv_id),
    quote       TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT 'yellow',
    page        INTEGER,
    note        TEXT,
    rects       TEXT,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Then extend `init()` to run an in-place migration after `executescript`. Replace the body of `init()` with:

```python
def init() -> None:
    """Create the database file and all tables if they don't exist.

    Also runs lightweight in-place migrations for older databases that pre-date
    a column. This is safe because Atlas is local single-user data.
    """
    with sqlite3.connect(db_path()) as conn:
        conn.executescript(SCHEMA)

        # Migration: add `rects TEXT` to highlights if it's missing (DBs
        # created before 2026-04-20).
        cur = conn.execute("PRAGMA table_info(highlights)")
        cols = {row[1] for row in cur.fetchall()}
        if "rects" not in cols:
            conn.execute("ALTER TABLE highlights ADD COLUMN rects TEXT")

        # Backfill papers_fts from existing rows when the FTS index is empty
        # but the papers table has data (older DBs created before FTS5 existed).
        cur = conn.execute("SELECT COUNT(*) FROM papers")
        paper_count = cur.fetchone()[0]
        cur = conn.execute("SELECT COUNT(*) FROM papers_fts")
        fts_count = cur.fetchone()[0]
        if paper_count > 0 and fts_count == 0:
            conn.execute(
                """INSERT INTO papers_fts (arxiv_id, title, authors, abstract, categories)
                   SELECT arxiv_id, title, authors, abstract, categories FROM papers"""
            )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest backend/tests/test_highlights_rects.py -v`
Expected: both tests PASS.

- [ ] **Step 5: Run the full backend suite to confirm no regressions**

Run: `pytest -v`
Expected: all previous tests (including `backend/tests/test_highlights.py`) still PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/db.py backend/tests/test_highlights_rects.py
git commit -m "feat(db): add rects column to highlights with idempotent migration"
```

---

## Task 2: Backend — round-trip `rects` through repository + routes

**Files:**
- Modify: `backend/app/highlights.py`
- Modify: `backend/app/main.py:230-258`
- Test: `backend/tests/test_highlights_rects.py` (extend)

- [ ] **Step 1: Write the failing round-trip tests**

Append to `backend/tests/test_highlights_rects.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient

from app import highlights, papers
from app.arxiv import Paper
from app.main import app


SAMPLE_R = Paper("rp1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


def test_add_stores_rects_as_json_and_list_for_returns_list(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE_R])
    rects = [
        {"x": 0.10, "y": 0.20, "width": 0.30, "height": 0.02},
        {"x": 0.10, "y": 0.24, "width": 0.25, "height": 0.02},
    ]
    new_id = highlights.add("rp1", "q", page=7, rects=rects)

    rows = highlights.list_for("rp1")
    assert len(rows) == 1
    assert rows[0]["id"] == new_id
    # list_for returns a Python list already deserialized from JSON.
    assert rows[0]["rects"] == rects


def test_add_allows_none_rects_for_backward_compat(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE_R])
    new_id = highlights.add("rp1", "q", page=1, rects=None)
    rows = highlights.list_for("rp1")
    assert rows[0]["rects"] is None
    assert rows[0]["id"] == new_id


@pytest.mark.asyncio
async def test_post_highlight_accepts_rects_and_get_returns_them(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE_R])
    rects = [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.02}]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        cr = await c.post(
            "/api/highlights/rp1",
            json={"quote": "hello", "color": "coral", "page": 2, "rects": rects},
        )
        assert cr.status_code == 200

        lr = await c.get("/api/highlights/rp1")
    assert lr.status_code == 200
    rows = lr.json()["highlights"]
    assert len(rows) == 1
    assert rows[0]["page"] == 2
    assert rows[0]["rects"] == rects
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest backend/tests/test_highlights_rects.py -v`
Expected: the three new tests FAIL — `highlights.add()` doesn't accept `rects`; the route body has no `rects`.

- [ ] **Step 3: Update `highlights.py` to accept + deserialize rects**

Replace the contents of `backend/app/highlights.py` with:

```python
"""Per-paper text highlights repository."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, List, Optional

from app import db


def _rects_to_json(rects: Optional[List[dict]]) -> Optional[str]:
    if rects is None:
        return None
    return json.dumps(rects, separators=(",", ":"))


def _rects_from_json(raw: Any) -> Optional[List[dict]]:
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = {k: row[k] for k in row.keys()}
    d["rects"] = _rects_from_json(d.get("rects"))
    return d


def add(
    arxiv_id: str,
    quote: str,
    color: str = "yellow",
    page: Optional[int] = None,
    note: Optional[str] = None,
    rects: Optional[List[dict]] = None,
) -> int:
    """Insert a new highlight row and return its primary key."""
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO highlights (arxiv_id, quote, color, page, note, rects) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (arxiv_id, quote, color, page, note, _rects_to_json(rects)),
        )
        return int(cur.lastrowid)


def list_for(arxiv_id: str) -> List[dict]:
    """Return highlights for a paper as plain dicts, newest first. `rects` is
    decoded from JSON back to a Python list (or None)."""
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT id, arxiv_id, quote, color, page, note, rects, created_at "
            "FROM highlights WHERE arxiv_id = ? ORDER BY created_at DESC, id DESC",
            (arxiv_id,),
        )
        return [_row_to_dict(r) for r in cur.fetchall()]


def delete(highlight_id: int) -> bool:
    """Delete a highlight by id. Returns True if a row was removed."""
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
        return cur.rowcount > 0
```

- [ ] **Step 4: Update the FastAPI route to accept + return `rects`**

In `backend/app/main.py`, find the `HighlightBody` model and the `/api/highlights/*` routes (lines 230-264) and replace them with:

```python
class HighlightBody(BaseModel):
    quote: str
    color: str = "yellow"
    page: int | None = None
    note: str | None = None
    rects: list[dict] | None = None


@app.get("/api/highlights/{arxiv_id}")
async def get_highlights(arxiv_id: str) -> dict:
    return {"highlights": highlights.list_for(arxiv_id)}


@app.post("/api/highlights/{arxiv_id}")
async def post_highlight(arxiv_id: str, body: HighlightBody) -> dict:
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")
    quote = body.quote.strip()
    if not quote:
        raise HTTPException(status_code=400, detail="quote must be non-empty")
    new_id = highlights.add(
        arxiv_id,
        quote,
        color=body.color or "yellow",
        page=body.page,
        note=body.note,
        rects=body.rects,
    )
    return {"id": new_id}


@app.delete("/api/highlights/{highlight_id}", status_code=204)
async def delete_highlight(highlight_id: int) -> Response:
    if not highlights.delete(highlight_id):
        raise HTTPException(status_code=404, detail="highlight not found")
    return Response(status_code=204)
```

Note: the old route used `_row_to_dict(r)` from `main.py` to coerce rows. We now delegate to `highlights.list_for()` which already returns dicts with parsed rects.

- [ ] **Step 5: Run the full backend suite**

Run: `pytest -v`
Expected: all tests PASS (including the pre-existing `test_highlights.py` which doesn't check rects — it continues to work because `rects` defaults to `None`).

- [ ] **Step 6: Commit**

```bash
git add backend/app/highlights.py backend/app/main.py backend/tests/test_highlights_rects.py
git commit -m "feat(highlights): round-trip rects through repository and HTTP"
```

---

## Task 3: Frontend — API types + lift highlights to `PaperReader`

**Files:**
- Modify: `frontend/src/lib/api.ts:90-126`
- Modify: `frontend/src/components/PaperReader.tsx`
- Modify: `frontend/src/components/HighlightsPanel.tsx`
- Modify: `frontend/src/components/RightPanel.tsx`

- [ ] **Step 1: Extend the API types + `createHighlight` signature**

In `frontend/src/lib/api.ts`, find the highlight types (around line 90) and replace that block with:

```ts
export type HighlightColor = "yellow" | "coral" | "blue";

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Highlight = {
  id: number;
  arxiv_id: string;
  quote: string;
  color: HighlightColor;
  page: number | null;
  note: string | null;
  rects: SelectionRect[] | null;
  created_at: string | null;
};

export async function fetchHighlights(arxivId: string): Promise<Highlight[]> {
  const r = await fetch(`/api/highlights/${encodeURIComponent(arxivId)}`);
  if (!r.ok) throw new Error(`/api/highlights/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.highlights as Highlight[];
}

export async function createHighlight(
  arxivId: string,
  input: {
    quote: string;
    color: HighlightColor;
    page?: number | null;
    note?: string | null;
    rects?: SelectionRect[] | null;
  },
): Promise<number> {
  const r = await fetch(`/api/highlights/${encodeURIComponent(arxivId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`POST /api/highlights/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.id as number;
}

export async function deleteHighlight(id: number): Promise<void> {
  const r = await fetch(`/api/highlights/${id}`, { method: "DELETE" });
  if (!r.ok && r.status !== 204) throw new Error(`DELETE /api/highlights/${id} -> ${r.status}`);
}
```

- [ ] **Step 2: Convert `HighlightsPanel` to controlled props (no internal fetch)**

Goal: move the `items` state and fetch/create/delete calls up to `PaperReader`. The panel takes `items`, `onAdd(input)`, `onDelete(id)`, `onJump(page)` props.

Replace the top of `frontend/src/components/HighlightsPanel.tsx` (down through the initial useEffect that fetches) with a prop-based shape. Specifically, replace lines 1-68 and 109-150 so the component signature is:

```ts
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import {
  type Highlight,
  type HighlightColor,
  type SelectionRect,
} from "@/lib/api";

const COLORS: { id: HighlightColor; label: string; swatch: string; bar: string }[] = [
  { id: "yellow", label: "Yellow", swatch: "#facc15", bar: "rgba(250,204,21,0.85)" },
  { id: "coral",  label: "Coral",  swatch: "#fb7185", bar: "rgba(251,113,133,0.85)" },
  { id: "blue",   label: "Blue",   swatch: "#60a5fa", bar: "rgba(96,165,250,0.85)" },
];

function colorBar(c: HighlightColor): string {
  return COLORS.find((x) => x.id === c)?.bar ?? COLORS[0].bar;
}

function looksSuspicious(text: string): boolean {
  if (text.length > 1500) return true;
  const newlines = (text.match(/\n/g) ?? []).length;
  if (newlines > 8) return true;
  const lower = text.trimStart().toLowerCase();
  if (lower.startsWith("#!")) return true;
  if (lower.startsWith("sudo ")) return true;
  if (lower.startsWith("curl ")) return true;
  if (lower.startsWith("http://") || lower.startsWith("https://")) return true;
  return false;
}

const BANNER_AUTO_DISMISS_MS = 3000;

type Props = {
  arxivId: string | undefined;
  items: Highlight[];
  onAdd: (input: {
    quote: string;
    color: HighlightColor;
    page?: number | null;
    rects?: SelectionRect[] | null;
  }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onJump: (page: number) => void;
};

export function HighlightsPanel({ arxivId, items, onAdd, onDelete, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draftQuote, setDraftQuote] = useState("");
  const [draftColor, setDraftColor] = useState<HighlightColor>("yellow");
  const [saving, setSaving] = useState(false);
  const [clipboardBanner, setClipboardBanner] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bannerTimerRef = useRef<number | null>(null);

  // (existing clipboard-banner useEffect stays the same — it only uses local
  // state, no external fetching)
```

Then, in the same file, replace the body of the local `save()` function (around line 111) with:

```ts
  async function save() {
    if (!arxivId) return;
    const quote = draftQuote.trim();
    if (!quote || saving) return;
    setSaving(true);
    try {
      await onAdd({ quote, color: draftColor });
      setDraftQuote("");
      setDraftColor("yellow");
      setAdding(false);
    } catch {
      // leave the form open so the user can retry
    } finally {
      setSaving(false);
    }
  }
```

And replace the local `remove()` function with:

```ts
  async function remove(id: number) {
    try {
      await onDelete(id);
    } catch {
      // parent is responsible for state reconciliation
    }
  }
```

Finally, make each highlight row's container clickable to jump to the page. Find the `{items.map((h) => (` block (around line 287) and wrap the inner `<div className="... text-[12px] text-slate-200 leading-snug overflow-hidden" ...>` in a button-like clickable region. Replace the whole row with:

```tsx
          {items.map((h) => (
            <div
              key={h.id}
              className="group relative rounded-md bg-white/[0.02] hover:bg-white/[0.04] pl-2.5 pr-7 py-1.5 transition-colors"
              style={{ borderLeft: `3px solid ${colorBar(h.color)}` }}
            >
              <button
                type="button"
                onClick={() => { if (h.page != null) onJump(h.page); }}
                className="block w-full text-left cursor-pointer"
                aria-label={h.page != null ? `Jump to page ${h.page}` : "highlight"}
              >
                <div
                  className="text-[12px] text-slate-200 leading-snug overflow-hidden"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                  title={h.quote}
                >
                  {h.quote}
                </div>
                {h.page != null && (
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    p.{h.page}
                  </div>
                )}
              </button>
              <button
                type="button"
                onClick={() => remove(h.id)}
                aria-label="Delete highlight"
                title="Delete highlight"
                className="absolute top-1 right-1 w-5 h-5 inline-flex items-center justify-center rounded text-slate-500 hover:text-rose-300 hover:bg-white/[0.06] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X size={11} />
              </button>
            </div>
          ))}
```

Remove the prior `useMatch` import (no longer needed) and the arxivId fetching effect (the first `useEffect` of the file, lines 58-68) — the parent now owns that.

- [ ] **Step 3: Lift highlights state into `PaperReader`**

Replace `frontend/src/components/PaperReader.tsx` with:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  createHighlight,
  deleteHighlight,
  fetchHighlights,
  type Highlight,
  type HighlightColor,
  type Paper,
  type SelectionRect,
} from "@/lib/api";
import { useUiStore } from "@/stores/ui-store";
import type { HighlightWithPosition, SelectionPayload } from "./PdfViewport";
import { PdfPage } from "./PdfPage";

type Props = { arxivId: string };

const OVERLAY_COLORS: Record<HighlightColor, string> = {
  yellow: "rgba(250,204,21,0.35)",
  coral:  "rgba(251,113,133,0.35)",
  blue:   "rgba(96,165,250,0.35)",
};

export function PaperReader({ arxivId }: Props) {
  const [, setPaper] = useState<Paper | null>(null);
  const mode = useUiStore((s) => s.readingMode);
  const setPinnedQuote = useUiStore((s) => s.setPinnedQuote);
  const lastHighlightColor = useUiStore((s) => s.lastHighlightColor);
  const setLastHighlightColor = useUiStore((s) => s.setLastHighlightColor);

  const [items, setItems] = useState<Highlight[]>([]);
  const [selection, setSelection] = useState<SelectionPayload | null>(null);
  const jumpRef = useRef<((pageNumber: number) => void) | null>(null);

  useEffect(() => {
    api.paper(arxivId).then(setPaper).catch(() => setPaper(null));
  }, [arxivId]);

  useEffect(() => {
    let alive = true;
    fetchHighlights(arxivId)
      .then((rows) => { if (alive) setItems(rows); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [arxivId]);

  const onSelection = useCallback((p: SelectionPayload | null) => {
    setSelection(p);
  }, []);

  const addHighlight = useCallback(
    async (input: {
      quote: string;
      color: HighlightColor;
      page?: number | null;
      rects?: SelectionRect[] | null;
    }) => {
      const id = await createHighlight(arxivId, input);
      setLastHighlightColor(input.color);
      setItems((prev) => [
        {
          id,
          arxiv_id: arxivId,
          quote: input.quote,
          color: input.color,
          page: input.page ?? null,
          note: null,
          rects: input.rects ?? null,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
    },
    [arxivId, setLastHighlightColor],
  );

  const removeHighlight = useCallback(async (id: number) => {
    const prev = items;
    setItems((cur) => cur.filter((h) => h.id !== id));
    try {
      await deleteHighlight(id);
    } catch {
      setItems(prev);
    }
  }, [items]);

  const onJump = useCallback((page: number) => {
    jumpRef.current?.(page);
  }, []);

  const saveFromSelection = useCallback(
    async (color: HighlightColor) => {
      if (!selection) return;
      await addHighlight({
        quote: selection.text,
        color,
        page: selection.page,
        rects: selection.rects,
      });
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    },
    [selection, addHighlight],
  );

  const askFromSelection = useCallback(() => {
    if (!selection) return;
    setPinnedQuote({ text: selection.text, page: selection.page });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, setPinnedQuote]);

  // Convert DB highlights to the viewport's overlay format. Highlights without
  // rects (the clipboard-paste legacy path) are dropped from the overlay but
  // still show in the side panel.
  const overlayHighlights: HighlightWithPosition[] = items.flatMap((h) => {
    if (!h.rects || h.page == null) return [];
    return [{
      id: h.id,
      page: h.page,
      color: OVERLAY_COLORS[h.color],
      rects: h.rects,
    }];
  });

  // Expose the panel data on window so RightPanel's HighlightsPanel instance
  // (rendered via RightPanel) can read it. Cleaner: lift RightPanel's
  // HighlightsPanel up here. See Task 5 for the wiring.
  // (intentionally minimal — real wiring done via context in next task)

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden p-4">
        <PdfPage
          fileUrl={api.pdfUrl(arxivId)}
          mode={mode}
          arxivId={arxivId}
          highlights={overlayHighlights}
          selection={selection}
          onSelection={onSelection}
          jumpRef={jumpRef}
          onHighlightSave={saveFromSelection}
          onHighlightAsk={askFromSelection}
          defaultHighlightColor={lastHighlightColor}
        />
      </div>
      {/* Panel is rendered in RightPanel; we bridge via HighlightsProvider
          context — see Task 5. */}
      <HighlightsBridge
        arxivId={arxivId}
        items={items}
        onAdd={addHighlight}
        onDelete={removeHighlight}
        onJump={onJump}
      />
    </div>
  );
}

// HighlightsBridge is defined in Task 5. For now, provide a stub that renders
// nothing so the file compiles while Task 5 is in flight.
function HighlightsBridge(_props: {
  arxivId: string;
  items: Highlight[];
  onAdd: (input: {
    quote: string;
    color: HighlightColor;
    page?: number | null;
    rects?: SelectionRect[] | null;
  }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onJump: (page: number) => void;
}) {
  return null;
}
```

Note: the props `selection`, `onSelection`, `onHighlightSave`, `onHighlightAsk`, `defaultHighlightColor`, `highlights`, `jumpRef` on `PdfPage` are added in Task 4. This file will not compile cleanly until Task 4 — that's expected. We commit this + Task 4 together if subagent runner fails here; otherwise proceed straight to Task 4.

- [ ] **Step 4: Commit (interim — will not build yet; fine in plan order)**

```bash
git add frontend/src/lib/api.ts frontend/src/components/HighlightsPanel.tsx frontend/src/components/PaperReader.tsx
git commit -m "refactor(highlights): lift state to PaperReader, add rects/page to API"
```

---

## Task 4: Frontend — `SelectionToolbar` + wire `PdfPage` → `PdfViewport`

**Files:**
- Create: `frontend/src/components/SelectionToolbar.tsx`
- Modify: `frontend/src/components/PdfPage.tsx`
- Create: `frontend/src/components/SelectionToolbar.test.tsx`

- [ ] **Step 1: Write the failing SelectionToolbar test**

Create `frontend/src/components/SelectionToolbar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectionToolbar } from "./SelectionToolbar";

describe("SelectionToolbar", () => {
  it("renders Highlight and Ask buttons and cycles color on color-swatch click", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn();
    const onAsk = vi.fn();

    render(
      <SelectionToolbar
        left={100}
        top={50}
        color="yellow"
        onHighlight={onHighlight}
        onAsk={onAsk}
      />,
    );

    const highlightBtn = screen.getByRole("button", { name: /highlight/i });
    await user.click(highlightBtn);
    expect(onHighlight).toHaveBeenCalledWith("yellow");

    const askBtn = screen.getByRole("button", { name: /ask/i });
    await user.click(askBtn);
    expect(onAsk).toHaveBeenCalled();
  });

  it("cycles default color when swatch clicked before Highlight", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn();

    render(
      <SelectionToolbar
        left={0}
        top={0}
        color="yellow"
        onHighlight={onHighlight}
        onAsk={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /cycle color/i }));
    await user.click(screen.getByRole("button", { name: /highlight/i }));
    expect(onHighlight).toHaveBeenCalledWith("coral");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && pnpm test:run SelectionToolbar`
Expected: FAIL with "Cannot find module './SelectionToolbar'".

- [ ] **Step 3: Implement `SelectionToolbar`**

Create `frontend/src/components/SelectionToolbar.tsx`:

```tsx
import { useState } from "react";
import { Highlighter, MessageSquare } from "lucide-react";
import type { HighlightColor } from "@/lib/api";

const COLOR_ORDER: HighlightColor[] = ["yellow", "coral", "blue"];

const SWATCH: Record<HighlightColor, string> = {
  yellow: "#facc15",
  coral:  "#fb7185",
  blue:   "#60a5fa",
};

type Props = {
  left: number;
  top: number;
  color: HighlightColor;
  onHighlight: (color: HighlightColor) => void;
  onAsk: () => void;
};

/**
 * Floating 2-button toolbar shown above the last selection rect. Offered the
 * user two actions: persist a highlight with the chosen color, or pin the
 * quote into the chat panel to ask about it.
 */
export function SelectionToolbar({ left, top, color, onHighlight, onAsk }: Props) {
  const [current, setCurrent] = useState<HighlightColor>(color);

  function cycle() {
    const next = COLOR_ORDER[(COLOR_ORDER.indexOf(current) + 1) % COLOR_ORDER.length];
    setCurrent(next);
  }

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="absolute z-20 flex items-center gap-1 rounded-full border border-white/10 px-1.5 py-1 backdrop-blur-md"
      style={{
        left,
        top,
        transform: "translate(-50%, -100%)",
        background: "rgba(12,14,20,0.85)",
        boxShadow:
          "0 8px 24px -10px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)",
      }}
    >
      <button
        type="button"
        aria-label="Cycle color"
        title="Cycle color"
        onClick={cycle}
        className="w-5 h-5 rounded-full border border-white/15 cursor-pointer"
        style={{ background: SWATCH[current] }}
      />
      <button
        type="button"
        aria-label="Highlight"
        title="Highlight"
        onClick={() => onHighlight(current)}
        className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] text-slate-100 hover:bg-white/10 transition-colors cursor-pointer"
      >
        <Highlighter size={12} />
        Highlight
      </button>
      <button
        type="button"
        aria-label="Ask"
        title="Ask about this"
        onClick={onAsk}
        className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] text-slate-100 hover:bg-white/10 transition-colors cursor-pointer"
      >
        <MessageSquare size={12} />
        Ask
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the SelectionToolbar test to verify it passes**

Run: `cd frontend && pnpm test:run SelectionToolbar`
Expected: both tests PASS.

- [ ] **Step 5: Extend `PdfPage` to accept + render the toolbar**

In `frontend/src/components/PdfPage.tsx`, extend the Props type + forward to `PdfViewport`. Replace the existing `type Props = { fileUrl: string; mode: ReadingMode; arxivId?: string; }` and the `PdfPage` function with:

```tsx
import type {
  HighlightWithPosition,
  SelectionPayload,
} from "./PdfViewport";
import type { HighlightColor } from "@/lib/api";
import { SelectionToolbar } from "./SelectionToolbar";

type Props = {
  fileUrl: string;
  mode: ReadingMode;
  arxivId?: string;
  highlights?: HighlightWithPosition[];
  selection: SelectionPayload | null;
  onSelection: (p: SelectionPayload | null) => void;
  jumpRef?: React.MutableRefObject<((pageNumber: number) => void) | null>;
  onHighlightSave: (color: HighlightColor) => Promise<void>;
  onHighlightAsk: () => void;
  defaultHighlightColor: HighlightColor;
};

export function PdfPage({
  fileUrl,
  mode,
  arxivId,
  highlights,
  selection,
  onSelection,
  jumpRef: externalJumpRef,
  onHighlightSave,
  onHighlightAsk,
  defaultHighlightColor,
}: Props) {
```

Replace the `jumpRef` declaration inside `PdfPage` (around line 100) with forwarding support:

```tsx
  const internalJumpRef = useRef<((pageNumber: number) => void) | null>(null);
  const jumpRef = externalJumpRef ?? internalJumpRef;
```

Now compute the toolbar position from the last selection rect and inject the toolbar. Find the `<PdfViewport ...>` call (around line 233) and replace the block with:

```tsx
        <PdfViewport
          fileUrl={fileUrl}
          mode={mode}
          scrollContainerRef={scrollContainerRef}
          jumpRef={jumpRef}
          onProgress={onProgress}
          onSections={setSections}
          onSelection={onSelection}
          highlights={highlights}
        />

        {selection && selection.rects.length > 0 && (() => {
          // Position the toolbar above the last selection rect. Rects are
          // normalized to the page — we ask PdfViewport for the page's
          // on-screen rect via a data attribute + scroll container lookup.
          const scrollEl = scrollContainerRef.current;
          const pageEl = scrollEl?.querySelector(
            `.pdf-page[data-page="${selection.page}"]`,
          ) as HTMLElement | null;
          if (!scrollEl || !pageEl) return null;
          const pageRect = pageEl.getBoundingClientRect();
          const cardRect = cardRef.current?.getBoundingClientRect();
          if (!cardRect) return null;
          const last = selection.rects[selection.rects.length - 1];
          const centerX = pageRect.left - cardRect.left + (last.x + last.width / 2) * pageRect.width;
          const topY = pageRect.top - cardRect.top + last.y * pageRect.height;
          return (
            <SelectionToolbar
              left={centerX}
              top={Math.max(topY - 6, 12)}
              color={defaultHighlightColor}
              onHighlight={(color) => void onHighlightSave(color)}
              onAsk={onHighlightAsk}
            />
          );
        })()}
```

- [ ] **Step 6: Run the frontend test suite to verify nothing regressed**

Run: `cd frontend && pnpm test:run`
Expected: previous tests PASS. SelectionToolbar tests PASS. (PdfViewport isn't tested here — wired up via PaperReader manual smoke.)

- [ ] **Step 7: Run `pnpm build` to verify TypeScript compiles**

Run: `cd frontend && pnpm build`
Expected: success. No type errors in PdfPage / PaperReader / SelectionToolbar.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/SelectionToolbar.tsx frontend/src/components/SelectionToolbar.test.tsx frontend/src/components/PdfPage.tsx
git commit -m "feat(pdf): floating selection toolbar — Highlight + Ask"
```

---

## Task 5: Frontend — `HighlightsBridge` via React context + update `RightPanel`

**Files:**
- Modify: `frontend/src/components/PaperReader.tsx`
- Modify: `frontend/src/components/RightPanel.tsx`

Problem: `RightPanel` renders `HighlightsPanel` but `PaperReader` owns the highlights state. We need a context that `PaperReader` provides and `RightPanel` consumes.

- [ ] **Step 1: Add a `HighlightsContext`**

In `frontend/src/components/PaperReader.tsx`, at the top of the file add:

```tsx
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
```

At the bottom of the file (replacing the `HighlightsBridge` stub from Task 3), add:

```tsx
type HighlightsContextValue = {
  arxivId: string;
  items: Highlight[];
  onAdd: (input: {
    quote: string;
    color: HighlightColor;
    page?: number | null;
    rects?: SelectionRect[] | null;
  }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onJump: (page: number) => void;
};

const HighlightsContext = createContext<HighlightsContextValue | null>(null);

export function useHighlightsContext(): HighlightsContextValue | null {
  return useContext(HighlightsContext);
}

export function HighlightsProvider({
  value,
  children,
}: {
  value: HighlightsContextValue;
  children: ReactNode;
}) {
  return (
    <HighlightsContext.Provider value={value}>
      {children}
    </HighlightsContext.Provider>
  );
}
```

Rename the `HighlightsBridge` call in `PaperReader`'s JSX. Since `PaperReader` sits inside the app tree but `RightPanel` is a sibling further up, we need to push the provider higher. Update the return to still render just the PDF, and expose the context from where `PaperReader` is mounted via a thin "mount to window" trick — simpler: we move the highlights state to a shared store slot.

**Revised simpler approach — use the Zustand store for highlights state.**

- [ ] **Step 2: Move highlights state into `ui-store.ts`**

In `frontend/src/stores/ui-store.ts`, add to the state (alongside `pinnedQuote` from Task 6 — this task and Task 6 touch the same file; do Task 6 first if running out of order, or combine them in one commit):

For this task, add just the slots for highlights-per-paper:

```ts
// Extend UiState:
  highlightsByPaper: Record<string, Highlight[]>;
  setHighlightsForPaper: (arxivId: string, items: Highlight[]) => void;
  upsertHighlight: (arxivId: string, item: Highlight) => void;
  removeHighlight: (arxivId: string, id: number) => void;
```

And the implementation inside `create()`:

```ts
      highlightsByPaper: {},
      setHighlightsForPaper: (arxivId, items) =>
        set((s) => ({
          highlightsByPaper: { ...s.highlightsByPaper, [arxivId]: items },
        })),
      upsertHighlight: (arxivId, item) =>
        set((s) => ({
          highlightsByPaper: {
            ...s.highlightsByPaper,
            [arxivId]: [item, ...(s.highlightsByPaper[arxivId] ?? [])],
          },
        })),
      removeHighlight: (arxivId, id) =>
        set((s) => ({
          highlightsByPaper: {
            ...s.highlightsByPaper,
            [arxivId]: (s.highlightsByPaper[arxivId] ?? []).filter((h) => h.id !== id),
          },
        })),
```

Add the import at the top of `ui-store.ts`:

```ts
import type { Highlight } from "@/lib/api";
```

`partialize` stays the same — highlights are ephemeral across sessions (the DB is the source of truth; we refetch on paper open).

- [ ] **Step 3: Rewire `PaperReader` to use the store**

Remove the `useState<Highlight[]>([])` from `PaperReader`. Read + write through the store:

Replace the relevant lines in `PaperReader` with:

```tsx
  const items = useUiStore((s) => s.highlightsByPaper[arxivId] ?? []);
  const setHighlightsForPaper = useUiStore((s) => s.setHighlightsForPaper);
  const upsertHighlight = useUiStore((s) => s.upsertHighlight);
  const removeHighlightLocal = useUiStore((s) => s.removeHighlight);

  useEffect(() => {
    let alive = true;
    fetchHighlights(arxivId)
      .then((rows) => { if (alive) setHighlightsForPaper(arxivId, rows); })
      .catch(() => { if (alive) setHighlightsForPaper(arxivId, []); });
    return () => { alive = false; };
  }, [arxivId, setHighlightsForPaper]);
```

And rewrite `addHighlight` / `removeHighlight`:

```tsx
  const addHighlight = useCallback(
    async (input: {
      quote: string;
      color: HighlightColor;
      page?: number | null;
      rects?: SelectionRect[] | null;
    }) => {
      const id = await createHighlight(arxivId, input);
      setLastHighlightColor(input.color);
      upsertHighlight(arxivId, {
        id,
        arxiv_id: arxivId,
        quote: input.quote,
        color: input.color,
        page: input.page ?? null,
        note: null,
        rects: input.rects ?? null,
        created_at: new Date().toISOString(),
      });
    },
    [arxivId, setLastHighlightColor, upsertHighlight],
  );

  const removeHighlightCb = useCallback(async (id: number) => {
    const prev = useUiStore.getState().highlightsByPaper[arxivId] ?? [];
    removeHighlightLocal(arxivId, id);
    try {
      await deleteHighlight(id);
    } catch {
      setHighlightsForPaper(arxivId, prev);
    }
  }, [arxivId, removeHighlightLocal, setHighlightsForPaper]);
```

Remove the `HighlightsProvider` / `HighlightsBridge` / context code — with a shared store, `HighlightsPanel` reads directly.

- [ ] **Step 4: Rewire `HighlightsPanel` to read from the store**

In `frontend/src/components/HighlightsPanel.tsx`, switch from props to store reads. Replace the component's `Props` type and the top of the function body with:

```tsx
import { useMatch } from "react-router-dom";
import { useUiStore } from "@/stores/ui-store";
import {
  createHighlight,
  deleteHighlight,
  type Highlight,
  type HighlightColor,
  type SelectionRect,
} from "@/lib/api";

// (keep COLORS, colorBar, looksSuspicious, BANNER_AUTO_DISMISS_MS as-is)

export function HighlightsPanel() {
  const match = useMatch("/reader/:arxivId");
  const arxivId = match?.params.arxivId;
  const items = useUiStore((s) =>
    arxivId ? (s.highlightsByPaper[arxivId] ?? []) : [],
  );
  const upsertHighlight = useUiStore((s) => s.upsertHighlight);
  const removeHighlightLocal = useUiStore((s) => s.removeHighlight);
  const setLastHighlightColor = useUiStore((s) => s.setLastHighlightColor);

  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draftQuote, setDraftQuote] = useState("");
  const [draftColor, setDraftColor] = useState<HighlightColor>("yellow");
  const [saving, setSaving] = useState(false);
  const [clipboardBanner, setClipboardBanner] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bannerTimerRef = useRef<number | null>(null);

  if (!arxivId) return null;

  async function save() {
    const quote = draftQuote.trim();
    if (!quote || saving) return;
    setSaving(true);
    try {
      const id = await createHighlight(arxivId!, { quote, color: draftColor });
      setLastHighlightColor(draftColor);
      upsertHighlight(arxivId!, {
        id,
        arxiv_id: arxivId!,
        quote,
        color: draftColor,
        page: null,
        note: null,
        rects: null,
        created_at: new Date().toISOString(),
      });
      setDraftQuote("");
      setDraftColor("yellow");
      setAdding(false);
    } catch {
      /* retry leaves form open */
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    const prev = items;
    removeHighlightLocal(arxivId!, id);
    try {
      await deleteHighlight(id);
    } catch {
      // restore by writing back the whole list
      useUiStore.getState().setHighlightsForPaper(arxivId!, prev);
    }
  }

  function jump(page: number) {
    window.dispatchEvent(new CustomEvent("atlas:jump-to-page", { detail: { page } }));
  }
  // jump() fires a custom DOM event; PaperReader attaches a listener that
  // calls jumpRef.current. Using DOM event-bus because the jumpRef lives in
  // a component far from the side panel and plumbing a store callback to
  // imperative DOM is awkward.
```

Then inside the `items.map((h) => ...)` row, change `onClick` on the jump button to call the local `jump(h.page)` helper:

```tsx
                onClick={() => { if (h.page != null) jump(h.page); }}
```

- [ ] **Step 5: Listen for `atlas:jump-to-page` in `PaperReader`**

In `PaperReader`, add:

```tsx
  useEffect(() => {
    const handler = (e: Event) => {
      const page = (e as CustomEvent<{ page: number }>).detail?.page;
      if (typeof page === "number") jumpRef.current?.(page);
    };
    window.addEventListener("atlas:jump-to-page", handler);
    return () => window.removeEventListener("atlas:jump-to-page", handler);
  }, []);
```

- [ ] **Step 6: Drop obsolete props on `RightPanel`**

Open `frontend/src/components/RightPanel.tsx` and confirm `HighlightsPanel` is invoked with no props (since we moved to store). If it was passing props, remove them. Most likely it's already `<HighlightsPanel />`.

- [ ] **Step 7: Run the full frontend build + tests**

Run: `cd frontend && pnpm test:run && pnpm build`
Expected: all tests PASS, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/stores/ui-store.ts frontend/src/components/PaperReader.tsx frontend/src/components/HighlightsPanel.tsx frontend/src/components/RightPanel.tsx
git commit -m "refactor(highlights): move state to ui-store; DOM event for jump"
```

---

## Task 6: Frontend — pinned quote in chat

**Files:**
- Modify: `frontend/src/stores/ui-store.ts`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Test: `frontend/src/components/ChatPanel.test.tsx` (new)

- [ ] **Step 1: Add `pinnedQuote` + `lastHighlightColor` to the store**

In `frontend/src/stores/ui-store.ts`, add these to the `UiState` type:

```ts
  pinnedQuote: { text: string; page: number } | null;
  setPinnedQuote: (q: { text: string; page: number }) => void;
  clearPinnedQuote: () => void;
  lastHighlightColor: HighlightColor;
  setLastHighlightColor: (c: HighlightColor) => void;
```

Add the import at the top:

```ts
import type { HighlightColor } from "@/lib/api";
```

And inside `create((set) => ({ ... }))`:

```ts
      pinnedQuote: null,
      setPinnedQuote: (q) => set({ pinnedQuote: q }),
      clearPinnedQuote: () => set({ pinnedQuote: null }),
      lastHighlightColor: "yellow",
      setLastHighlightColor: (c) => set({ lastHighlightColor: c }),
```

Extend `partialize` so `lastHighlightColor` persists but `pinnedQuote` does not:

```ts
      partialize: (s) => ({
        paletteId: s.paletteId,
        customPalette: s.customPalette,
        leftCollapsed: s.leftCollapsed,
        rightCollapsed: s.rightCollapsed,
        readingMode: s.readingMode,
        model: s.model,
        lastHighlightColor: s.lastHighlightColor,
      }),
```

- [ ] **Step 2: Write the failing ChatPanel pinned-quote test**

Create `frontend/src/components/ChatPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useUiStore } from "@/stores/ui-store";
import { ChatPanel } from "./ChatPanel";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    streamAsk: vi.fn(async (_id, question, _history, handlers) => {
      (handlers as { onChunk: (s: string) => void; onDone: () => void }).onChunk(
        `echo:${question}`,
      );
      (handlers as { onDone: () => void }).onDone();
    }),
    streamSummary: vi.fn(),
    fetchGlossary: vi.fn(async () => []),
  };
});

function renderInReader() {
  return render(
    <MemoryRouter initialEntries={["/reader/abc"]}>
      <Routes>
        <Route path="/reader/:arxivId" element={<ChatPanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatPanel pinned quote", () => {
  beforeEach(() => {
    useUiStore.setState({ pinnedQuote: null });
  });

  it("renders the pinned-quote chip when set and prepends on send", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      pinnedQuote: { text: "Tensor cores saturate here", page: 4 },
    });

    renderInReader();

    expect(screen.getByText(/Tensor cores saturate here/)).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/Ask anything about this paper/);
    await user.type(textarea, "why?");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const { streamAsk } = await import("@/lib/api");
    expect(streamAsk).toHaveBeenCalled();
    const callArg = (streamAsk as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(callArg).toContain("Tensor cores saturate here");
    expect(callArg).toContain("why?");

    // Chip cleared after send.
    expect(useUiStore.getState().pinnedQuote).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && pnpm test:run ChatPanel`
Expected: FAIL — chip doesn't render because ChatPanel doesn't read `pinnedQuote`.

- [ ] **Step 4: Render the chip + prepend on send**

In `frontend/src/components/ChatPanel.tsx`, read the pinned quote from the store. Add alongside the other `useUiStore` selectors (around line 101):

```ts
  const pinnedQuote = useUiStore((s) => s.pinnedQuote);
  const clearPinnedQuote = useUiStore((s) => s.clearPinnedQuote);
```

Update `send()` (around line 166) to prepend the quote:

```ts
  async function send(overridePrompt?: string) {
    const typed = (overridePrompt ?? draft).trim();
    if (!arxivId || streaming) return;
    if (!typed && !pinnedQuote) return;
    const question = pinnedQuote
      ? `> ${pinnedQuote.text.replace(/\n/g, "\n> ")}\n\n${typed}`.trim()
      : typed;
    if (!question) return;
    const historyForBackend = messages;
    setDraft("");
    clearPinnedQuote();
    setMessages((m) => [
      ...m,
      { role: "user", content: question },
      { role: "assistant", content: "", model },
    ]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamAsk(arxivId, question, historyForBackend, {
        onChunk: appendChunk,
        onDone: () => setStreaming(false),
        onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
      }, abortRef.current.signal, model);
    } catch {
      setStreaming(false);
    }
  }
```

Inside the JSX, just above the `<textarea>` (around line 255, inside the textarea's wrapping div), add the chip:

```tsx
          {pinnedQuote && (
            <div
              className="rounded-lg bg-white/[0.04] border border-[color:var(--ac1-mid)] px-3 py-2 flex items-start gap-2"
              role="note"
              aria-label="Quote pinned for next question"
            >
              <span
                className="mt-0.5 w-1 self-stretch rounded-full"
                style={{ background: "var(--ac1)" }}
                aria-hidden
              />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
                  Asking about · p.{pinnedQuote.page}
                </div>
                <div
                  className="text-[12px] text-slate-200 leading-snug overflow-hidden"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}
                  title={pinnedQuote.text}
                >
                  {pinnedQuote.text}
                </div>
              </div>
              <button
                type="button"
                onClick={clearPinnedQuote}
                aria-label="Remove pinned quote"
                className="text-slate-500 hover:text-slate-200 cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}
```

Update the send button's `disabled` condition (around line 275) so it enables when only a pinned quote is present:

```tsx
                disabled={!streaming && !draft.trim() && !pinnedQuote}
```

And the button-style `draft.trim()` branches (around lines 283-298) — replace each `draft.trim()` with `(draft.trim() || pinnedQuote)` so the "ready to send" glow kicks in when there's a quote.

- [ ] **Step 5: Run the ChatPanel test to verify it passes**

Run: `cd frontend && pnpm test:run ChatPanel`
Expected: PASS.

- [ ] **Step 6: Run the full frontend test + build**

Run: `cd frontend && pnpm test:run && pnpm build`
Expected: all tests PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/stores/ui-store.ts frontend/src/components/ChatPanel.tsx frontend/src/components/ChatPanel.test.tsx
git commit -m "feat(chat): pinned-quote chip for Ask-about-this"
```

---

## Task 7: Dockerize

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Modify: `README.md`

- [ ] **Step 1: Write `.dockerignore`**

Create `.dockerignore` at repo root:

```
.git
.gitignore
.venv
__pycache__
*.pyc
node_modules
frontend/dist
.pytest_cache
.ruff_cache
.DS_Store
.atlas
atlas-data
.playwright-mcp
*.log
docs
backend/atlas.egg-info
```

- [ ] **Step 2: Write the Dockerfile**

Create `Dockerfile` at repo root:

```dockerfile
# syntax=docker/dockerfile:1.7

# -------- Stage 1: build frontend --------
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
RUN corepack enable

COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm build

# -------- Stage 2: python runtime --------
FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ATLAS_DATA_DIR=/data

# Install the backend in-place.
COPY pyproject.toml ./
COPY backend/ ./backend/
RUN pip install --no-cache-dir -e .

# Drop in the prebuilt frontend. FastAPI serves it via StaticFiles (see main.py).
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /data

EXPOSE 8765
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765", "--app-dir", "backend"]
```

- [ ] **Step 3: Write `docker-compose.yml`**

Create `docker-compose.yml` at repo root:

```yaml
services:
  atlas:
    build: .
    image: atlas:local
    container_name: atlas
    ports:
      - "8765:8765"
    environment:
      ATLAS_DATA_DIR: /data
    volumes:
      - ./atlas-data:/data
    restart: unless-stopped
```

- [ ] **Step 4: Verify FastAPI serves the built frontend**

Open `backend/app/main.py` and confirm a `StaticFiles` mount exists for the frontend dist. Run:

```bash
grep -n "StaticFiles\|frontend/dist\|mount" backend/app/main.py
```

If there's no static mount (or it points somewhere else), add near the bottom of `main.py`:

```python
# Serve the built frontend in production (and inside Docker). In dev, vite
# proxies to this API server on :8765, so this mount is inert.
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
```

(Already present in most of the codebase — verify before editing.)

- [ ] **Step 5: Build the image**

Run: `docker compose build`
Expected: both stages complete. `atlas:local` image is created.

- [ ] **Step 6: Run the container and smoke-test the API**

Run:

```bash
docker compose up -d
sleep 3
curl -s http://localhost:8765/api/health
```

Expected: JSON like `{"ai": false, "papers_today": 0}`. (AI is off inside the container by design.)

Then open `http://localhost:8765` in a browser — the Atlas UI should load.

- [ ] **Step 7: Tear down**

Run:

```bash
docker compose down
```

- [ ] **Step 8: Update README**

In `README.md`, append a new section after "Autostart on login":

```markdown
## Docker

Spin up with one command:

```bash
docker compose up --build
```

Open http://localhost:8765.

Data persists in `./atlas-data/` (mounted into the container at `/data`).

**Caveat — AI features:** Atlas's summarizer and chat use the local `claude -p` CLI + your Claude subscription. The container doesn't have the CLI or your login, so `/api/health` will report `ai: false` and Ask/Summarize will be unavailable. The reader, digest, highlights, and search all work. For AI features, use `atlas up` on the host.
```

- [ ] **Step 9: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore README.md
git commit -m "feat(ops): Dockerfile + compose for single-command spin-up"
```

---

## Task 8: Run + manual smoke test (end-to-end)

**Files:** none

- [ ] **Step 1: Start the app locally**

Run from the repo root in one terminal:

```bash
source .venv/bin/activate   # if .venv exists; otherwise python3.12 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
cd frontend && pnpm install && pnpm build && cd ..
atlas up
```

Expected: browser opens at `http://localhost:8765` with today's digest.

- [ ] **Step 2: Highlight smoke**

1. Click a paper → PDF opens.
2. Drag to select a sentence inside the PDF.
3. A floating toolbar appears above the selection with a color swatch, "Highlight", and "Ask" buttons.
4. Click "Highlight" → a yellow overlay is drawn over the selected sentence.
5. The side panel's Highlights section shows the new quote with `p.N`.
6. Refresh the page → the overlay still shows.

- [ ] **Step 3: Ask smoke**

1. Select another sentence.
2. Click "Ask" → chip appears above the chat input, showing the quote and page number.
3. Type "summarize in one sentence" → click send.
4. The streamed answer references the quote.
5. The chip disappears after sending.

- [ ] **Step 4: Jump smoke**

1. Scroll the PDF to page 1.
2. In the Highlights side panel, click a row for a highlight on page N (> 1).
3. The PDF scrolls to page N.

- [ ] **Step 5: Delete smoke**

1. Hover a panel row → a × button appears.
2. Click × → the overlay and panel row disappear.
3. Refresh → still gone.

- [ ] **Step 6: Docker smoke**

Stop local `atlas` (Ctrl-C or `atlas stop`). Run:

```bash
docker compose up --build -d
sleep 3
open http://localhost:8765
```

Repeat steps 2–5 inside the container (AI features will be disabled — that's expected).

Run `docker compose down` when done.

- [ ] **Step 7: Commit any tweaks found during smoke**

If smoke testing surfaces small fixes, make them and commit as `fix(highlights): <thing>` before proceeding. If clean, move on.

---

## Self-Review Notes

**Spec coverage:**
- Text layer + selection → rects: already in `PdfViewport` (unmodified, confirmed lines 384, 494-548).
- Floating toolbar: Task 4.
- Highlight action with persistent overlay + DB rects: Tasks 1, 2, 3, 4, 5.
- Ask action with pinned quote chip: Tasks 5 (store), 6 (chip).
- `rects` column + migration + idempotency: Task 1.
- Old clipboard-only highlights keep working (no rects, no overlay): confirmed by `test_add_allows_none_rects_for_backward_compat` and overlay `flatMap` that skips rect-less items.
- Dockerfile + compose: Task 7.
- Claude CLI caveat documented: Task 7 step 8.
- Run smoke: Task 8.

**Type consistency:**
- `SelectionRect` is defined in `api.ts` (Task 3) and used by `PdfViewport` (existing `SelectionRect` type in that file is identical shape — kept as a re-export or duplicate; on second pass, import from `@/lib/api` to avoid duplication).
- `HighlightColor` is shared between `api.ts`, `ui-store.ts`, `SelectionToolbar`, and `HighlightsPanel`.
- `SelectionPayload` and `HighlightWithPosition` stay in `PdfViewport.tsx` (already exported).

**No placeholders:** every step has exact code, exact paths, exact commands.

**Scope:** single plan, produces working software. The store-based bridge (Task 5) keeps panel and reader decoupled without prop drilling through `RightPanel`.
