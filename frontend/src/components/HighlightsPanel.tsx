import { useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import {
  type Highlight,
  type HighlightColor,
  createHighlight,
  deleteHighlight,
  fetchHighlights,
} from "@/lib/api";
import { useHighlightsContext } from "./PaperReader";

const COLORS: { id: HighlightColor; label: string; swatch: string; bar: string }[] = [
  { id: "yellow", label: "Yellow", swatch: "#facc15", bar: "rgba(250,204,21,0.85)" },
  { id: "coral",  label: "Coral",  swatch: "#fb7185", bar: "rgba(251,113,133,0.85)" },
  { id: "blue",   label: "Blue",   swatch: "#60a5fa", bar: "rgba(96,165,250,0.85)" },
];

function colorBar(c: HighlightColor): string {
  return COLORS.find((x) => x.id === c)?.bar ?? COLORS[0].bar;
}

/**
 * Guardrails for the clipboard auto-fill. We don't want to shove a shell
 * command or a multi-screen blob into the highlight quote field just because
 * the user happened to have it on their clipboard. Simple heuristics only —
 * anything actually malicious will still get dropped in, but the common
 * "oops, my last Cmd+C was a terminal command" case is covered.
 */
function looksSuspicious(text: string): boolean {
  if (text.length > 1500) return true;
  // Many newlines suggests it's not a quote from a paper.
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

export function HighlightsPanel() {
  const match = useMatch("/reader/:arxivId");
  const arxivId = match?.params.arxivId;
  const ctx = useHighlightsContext();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Highlight[]>([]);
  const [adding, setAdding] = useState(false);
  const [draftQuote, setDraftQuote] = useState("");
  const [draftColor, setDraftColor] = useState<HighlightColor>("yellow");
  const [saving, setSaving] = useState(false);
  const [clipboardBanner, setClipboardBanner] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bannerTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!arxivId) {
      setItems([]);
      return;
    }
    let alive = true;
    fetchHighlights(arxivId)
      .then((rows) => { if (alive) setItems(rows); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [arxivId]);

  useEffect(() => {
    if (!adding) {
      // Clean up the banner dismiss timer when the draft closes.
      if (bannerTimerRef.current !== null) {
        window.clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = null;
      }
      setClipboardBanner(false);
      return;
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
    // Try to auto-prefill from the clipboard. The iframe PDF viewer doesn't
    // expose selection to JS, but the user can Cmd+C inside it and we read
    // the clipboard here. Only triggers if the textarea is currently empty.
    if (draftQuote === "" && navigator.clipboard?.readText) {
      navigator.clipboard.readText().then((text) => {
        const trimmed = text?.trim();
        if (!trimmed) return;
        // Bail out on content that looks like a shell command or a giant
        // blob — almost certainly not a quote the user wants to highlight.
        if (looksSuspicious(trimmed)) return;
        setDraftQuote(trimmed);
        setClipboardBanner(true);
        if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = window.setTimeout(() => {
          setClipboardBanner(false);
          bannerTimerRef.current = null;
        }, BANNER_AUTO_DISMISS_MS);
      }).catch(() => { /* clipboard permission denied — silent */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    };
  }, []);

  if (!arxivId) return null;

  const displayItems = ctx?.items ?? items;

  async function save() {
    if (!arxivId) return;
    const quote = draftQuote.trim();
    if (!quote || saving) return;
    setSaving(true);
    try {
      if (ctx) {
        // Context path: PaperReader owns the list; don't touch local state.
        await ctx.onAdd({ quote, color: draftColor });
      } else {
        const id = await createHighlight(arxivId, { quote, color: draftColor });
        // Optimistic prepend; matches backend "newest first" ordering.
        setItems((prev) => [
          {
            id,
            arxiv_id: arxivId,
            quote,
            color: draftColor,
            page: null,
            note: null,
            rects: null,
            created_at: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
      setDraftQuote("");
      setDraftColor("yellow");
      setAdding(false);
    } catch {
      // leave the form open so the user can retry
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (ctx) {
      await ctx.onDelete(id);
      return;
    }
    const prev = items;
    setItems((cur) => cur.filter((h) => h.id !== id));
    try {
      await deleteHighlight(id);
    } catch {
      // restore on failure
      setItems(prev);
    }
  }

  return (
    <div className="border-b border-white/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open
            ? <ChevronDown size={14} className="text-slate-400" />
            : <ChevronRight size={14} className="text-slate-400" />}
          <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
            Highlights
          </span>
          {displayItems.length > 0 && (
            <span className="text-[10px] text-slate-500 font-mono">{displayItems.length}</span>
          )}
        </span>
        <span
          role="button"
          tabIndex={0}
          aria-label="Add highlight"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
            setAdding(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(true);
              setAdding(true);
            }
          }}
          className="w-6 h-6 inline-flex items-center justify-center rounded-md border border-white/10 text-slate-300 hover:text-white hover:border-white/20 cursor-pointer"
        >
          <Plus size={12} />
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          {adding && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 flex flex-col gap-2">
              {clipboardBanner && (
                <div
                  role="status"
                  className="text-[10px] text-amber-300/80 px-1 leading-snug"
                >
                  Filled from clipboard — ⌘Z to undo, or click Cancel
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={draftQuote}
                onChange={(e) => {
                  setDraftQuote(e.target.value);
                  if (clipboardBanner) {
                    setClipboardBanner(false);
                    if (bannerTimerRef.current !== null) {
                      window.clearTimeout(bannerTimerRef.current);
                      bannerTimerRef.current = null;
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    save();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setAdding(false);
                    setDraftQuote("");
                  }
                }}
                placeholder="Paste or type the quote... (Cmd+Enter to save)"
                rows={3}
                className="w-full bg-transparent border-0 outline-none text-[12px] text-slate-200 placeholder:text-slate-500 resize-none"
              />
              <div className="text-[10px] text-slate-500 -mt-1">
                Tip: select text in the PDF, press <kbd className="px-1 py-px border border-white/10 rounded font-mono text-[9px]">⌘C</kbd>, then click <kbd className="px-1 py-px border border-white/10 rounded font-mono text-[9px]">+</kbd> — your clipboard auto-fills here.
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {COLORS.map((c) => {
                    const active = draftColor === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setDraftColor(c.id)}
                        aria-pressed={active}
                        aria-label={`${c.label} highlight`}
                        title={c.label}
                        className="w-5 h-5 rounded-full border transition-transform"
                        style={{
                          background: c.swatch,
                          borderColor: active ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.15)",
                          transform: active ? "scale(1.15)" : "scale(1)",
                          boxShadow: active ? "0 0 0 2px rgba(255,255,255,0.18)" : "none",
                        }}
                      />
                    );
                  })}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => { setAdding(false); setDraftQuote(""); }}
                    className="px-2 py-1 rounded-md text-[11px] text-slate-300 border border-white/10 hover:border-white/25 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={!draftQuote.trim() || saving}
                    className="px-2.5 py-1 rounded-md text-[11px] font-semibold disabled:opacity-50 cursor-pointer"
                    style={{ background: "var(--user-grad)", color: "var(--user-ink)" }}
                  >
                    {saving ? "Saving..." : "Highlight"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {displayItems.length === 0 && !adding && (
            <div className="text-[11px] text-slate-500 px-1 py-2 leading-relaxed">
              Click + to add a highlight.
            </div>
          )}

          {displayItems.map((h) => (
            <div
              key={h.id}
              className="group relative rounded-md bg-white/[0.02] hover:bg-white/[0.04] pl-2.5 pr-7 py-1.5 transition-colors"
              style={{ borderLeft: `3px solid ${colorBar(h.color)}` }}
            >
              <button
                type="button"
                onClick={() => {
                  if (ctx && h.page != null) ctx.onJump(h.page);
                }}
                disabled={!ctx || h.page == null}
                title={h.quote}
                className="block w-full text-left text-[12px] text-slate-200 leading-snug overflow-hidden bg-transparent border-0 p-0 m-0 disabled:cursor-default enabled:cursor-pointer"
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {h.quote}
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
        </div>
      )}
    </div>
  );
}
