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

const COLORS: { id: HighlightColor; label: string; swatch: string; bar: string }[] = [
  { id: "yellow", label: "Yellow", swatch: "#facc15", bar: "rgba(250,204,21,0.85)" },
  { id: "coral",  label: "Coral",  swatch: "#fb7185", bar: "rgba(251,113,133,0.85)" },
  { id: "blue",   label: "Blue",   swatch: "#60a5fa", bar: "rgba(96,165,250,0.85)" },
];

function colorBar(c: HighlightColor): string {
  return COLORS.find((x) => x.id === c)?.bar ?? COLORS[0].bar;
}

export function HighlightsPanel() {
  const match = useMatch("/reader/:arxivId");
  const arxivId = match?.params.arxivId;

  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<Highlight[]>([]);
  const [adding, setAdding] = useState(false);
  const [draftQuote, setDraftQuote] = useState("");
  const [draftColor, setDraftColor] = useState<HighlightColor>("yellow");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    if (adding) {
      // focus the textarea when the form opens
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [adding]);

  if (!arxivId) return null;

  async function save() {
    if (!arxivId) return;
    const quote = draftQuote.trim();
    if (!quote || saving) return;
    setSaving(true);
    try {
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
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
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
          {items.length > 0 && (
            <span className="text-[10px] text-slate-500 font-mono">{items.length}</span>
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
              <textarea
                ref={textareaRef}
                value={draftQuote}
                onChange={(e) => setDraftQuote(e.target.value)}
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

          {items.length === 0 && !adding && (
            <div className="text-[11px] text-slate-500 px-1 py-2 leading-relaxed">
              Click + to add a highlight.
            </div>
          )}

          {items.map((h) => (
            <div
              key={h.id}
              className="group relative rounded-md bg-white/[0.02] hover:bg-white/[0.04] pl-2.5 pr-7 py-1.5 transition-colors"
              style={{ borderLeft: `3px solid ${colorBar(h.color)}` }}
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
