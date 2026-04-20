import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Paper } from "@/lib/api";
import { groupPapersByDay } from "@/lib/group-by-day";
import { UrlBar } from "./UrlBar";
import { PaperRow } from "./PaperRow";

const TIER_META = {
  A: { label: "Must read",     icon: "🔥", color: "#fb7185" },
  B: { label: "Worth knowing", icon: "⭐", color: "#fbbf24" },
  C: { label: "Peripheral",    icon: "📄", color: "#94a3b8" },
} as const;

type TierKey = keyof typeof TIER_META;

function tierFor(p: Paper): TierKey | null {
  if (p.ai_tier == null) return null;
  if (p.ai_tier >= 4) return "A";
  if (p.ai_tier >= 2) return "B";
  return "C";
}

function groupByTier(papers: Paper[]): Record<TierKey, Paper[]> {
  const out: Record<TierKey, Paper[]> = { A: [], B: [], C: [] };
  for (const p of papers) {
    const t = tierFor(p);
    if (t) out[t].push(p);
  }
  return out;
}

export function PaperList() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let res = await api.digest(false);
        if (res.count === 0) {
          res = await api.digest(true);
        }
        if (!cancelled) setPapers(res.papers);
      } catch {
        if (!cancelled) setPapers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hasTiers = papers.some((p) => p.ai_tier != null);
  const tierGroups = hasTiers ? groupByTier(papers) : null;
  const dayGroups = hasTiers ? null : groupPapersByDay(papers);

  // Flattened row order so arrow-key nav can walk the visible list regardless
  // of whether we're rendering tier groups or day groups. The visual grouping
  // is decorative, navigation is one-dimensional.
  const flatPapers = useMemo<Paper[]>(() => {
    if (tierGroups) {
      return (["A", "B", "C"] as TierKey[]).flatMap((t) => tierGroups[t]);
    }
    if (dayGroups) {
      return dayGroups.flatMap((g) => g.papers);
    }
    return [];
  }, [tierGroups, dayGroups]);

  // Reset active index on first load / whenever the list shrinks below it.
  useEffect(() => {
    if (activeIndex >= flatPapers.length && flatPapers.length > 0) {
      setActiveIndex(0);
    }
  }, [flatPapers.length, activeIndex]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (flatPapers.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatPapers.length - 1));
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = flatPapers[activeIndex];
      if (p) navigate(`/reader/${p.arxiv_id}`);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(flatPapers.length - 1);
    }
  }

  // Scroll the active row into view when it changes.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = flatPapers[activeIndex];
    if (!active) return;
    const el = list.querySelector<HTMLElement>(
      `[data-arxiv-id="${CSS.escape(active.arxiv_id)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, flatPapers]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/5">
        <div className="text-[11px] uppercase tracking-wider text-slate-500">Today {"\u00b7"} {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        <div className="text-[15px] font-semibold mt-0.5 text-slate-100 flex items-center gap-2">
          Daily digest
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-slate-400 font-medium">
            {hasTiers ? "AI-ranked" : "Newest first"}
          </span>
        </div>
      </div>
      <UrlBar onSubmit={(id) => navigate(`/reader/${id}`)} />
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
        role="listbox"
        aria-label="Papers"
        aria-activedescendant={
          flatPapers[activeIndex]
            ? `paper-row-${flatPapers[activeIndex].arxiv_id}`
            : undefined
        }
        tabIndex={flatPapers.length > 0 ? 0 : -1}
        onKeyDown={onKeyDown}
      >
        {loading && <div className="px-4 py-3 text-xs text-slate-500">Loading...</div>}
        {!loading && papers.length === 0 && (
          <div className="px-4 py-3 text-xs text-slate-500">No papers yet. Build the digest from the backend.</div>
        )}
        {tierGroups && (["A", "B", "C"] as TierKey[]).map((tier) => {
          const items = tierGroups[tier];
          if (items.length === 0) return null;
          const meta = TIER_META[tier];
          return (
            <div key={tier} role="group" aria-label={meta.label}>
              <div
                className="px-3 pt-2.5 pb-1 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5"
                style={{ color: meta.color }}
              >
                <span aria-hidden>{meta.icon}</span>
                {meta.label} ({items.length})
              </div>
              {items.map((p) => {
                const flatIdx = flatPapers.indexOf(p);
                return (
                  <PaperRow
                    key={p.arxiv_id}
                    paper={p}
                    isActiveRow={flatIdx === activeIndex}
                    onFocusRequest={() => setActiveIndex(flatIdx)}
                  />
                );
              })}
            </div>
          );
        })}
        {dayGroups && dayGroups.map((g) => (
          <div key={g.isoDate} role="group" aria-label={g.dateLabel}>
            <div className="px-3 pt-2.5 pb-1 text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-600" />
              {g.dateLabel} ({g.count})
            </div>
            {g.papers.map((p) => {
              const flatIdx = flatPapers.indexOf(p);
              return (
                <PaperRow
                  key={p.arxiv_id}
                  paper={p}
                  isActiveRow={flatIdx === activeIndex}
                  onFocusRequest={() => setActiveIndex(flatIdx)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
