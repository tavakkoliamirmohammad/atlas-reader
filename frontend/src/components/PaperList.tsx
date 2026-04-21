import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Paper } from "@/lib/api";
import { groupPapersByDay } from "@/lib/group-by-day";
import { useUiStore, type DigestRange } from "@/stores/ui-store";
import { UrlBar } from "./UrlBar";
import { PaperRow } from "./PaperRow";

const RANGE_OPTIONS: { value: DigestRange; label: string }[] = [
  { value: 1,     label: "1d" },
  { value: 3,     label: "3d" },
  { value: 7,     label: "7d" },
  { value: 14,    label: "14d" },
  { value: 30,    label: "30d" },
  { value: "all", label: "All" },
];

type RangeCounts = Partial<Record<string, number>>;

function rangeKey(r: DigestRange): string {
  return String(r);
}

function countInRange(papers: Paper[], range: DigestRange): number {
  if (range === "all") return papers.length;
  const cutoffMs = Date.now() - range * 24 * 60 * 60 * 1000;
  return papers.filter((p) => new Date(p.published).getTime() >= cutoffMs).length;
}

function computeAllCounts(papers: Paper[]): RangeCounts {
  const out: RangeCounts = {};
  for (const opt of RANGE_OPTIONS) {
    out[rangeKey(opt.value)] = countInRange(papers, opt.value);
  }
  return out;
}

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
  const [rangeCounts, setRangeCounts] = useState<RangeCounts | null>(null);
  const [filter, setFilter] = useState("");
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const segRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null);
  const digestRange = useUiStore((s) => s.digestRange);
  const setDigestRange = useUiStore((s) => s.setDigestRange);

  // Reset filter when the user switches range so "no results" in 3d doesn't
  // silently hide all 30d papers too.
  useEffect(() => { setFilter(""); }, [digestRange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Clear the previous range's papers immediately so the user never sees a
    // stale list during the switch — otherwise picking 3d after 7d keeps the
    // 7d rows visible until the new fetch lands, which reads as "filter broken".
    setPapers([]);
    (async () => {
      try {
        const res = await api.digest(false, digestRange);
        if (!cancelled) {
          setPapers(res.papers);
          // If the user is on "all", we already have what we need to compute
          // all-segment counts — skip the extra background fetch.
          if (digestRange === "all") {
            setRangeCounts(computeAllCounts(res.papers));
          }
        }
      } catch {
        if (!cancelled) setPapers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [digestRange]);

  // One-time background fetch for the full archive so every segment can show a
  // real count without forcing the user to switch ranges. If the initial range
  // is already "all", the primary effect above has already populated counts.
  useEffect(() => {
    if (rangeCounts) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.digest(false, "all");
        if (!cancelled) setRangeCounts(computeAllCounts(res.papers));
      } catch {
        // Leave rangeCounts null; UI falls back to em-dashes.
      }
    })();
    return () => { cancelled = true; };
    // Deliberately runs only on mount — the "all" fetch is a one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure the active segment so the sliding indicator lines up precisely.
  // Re-run on range change and on container resize (left panel collapse).
  useLayoutEffect(() => {
    function measure() {
      const idx = RANGE_OPTIONS.findIndex((o) => o.value === digestRange);
      const btn = segRefs.current[idx];
      const container = pickerRef.current;
      if (!btn || !container) return;
      setInk({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
    measure();
    const container = pickerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [digestRange]);

  function handleRangeKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (i + dir + RANGE_OPTIONS.length) % RANGE_OPTIONS.length;
    segRefs.current[next]?.focus();
    setDigestRange(RANGE_OPTIONS[next].value);
  }

  // Apply the in-range text filter client-side. Matches title, authors, or
  // abstract (case-insensitive substring). Empty filter = no-op.
  const filteredPapers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return papers;
    return papers.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.authors.toLowerCase().includes(q) ||
        p.abstract.toLowerCase().includes(q),
    );
  }, [papers, filter]);

  const hasTiers = filteredPapers.some((p) => p.ai_tier != null);
  const tierGroups = hasTiers ? groupByTier(filteredPapers) : null;
  const dayGroups = hasTiers ? null : groupPapersByDay(filteredPapers);

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
      <div className="px-4 py-3">
        <div className="text-[11px] uppercase tracking-wider text-slate-500">Today {"\u00b7"} {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
      </div>
      <UrlBar onSubmit={(id) => navigate(`/reader/${id}`)} />
      <div className="px-2 pb-2 relative">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter in range…"
          aria-label="Filter papers in current range"
          className="w-full text-[12px] px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/5 placeholder:text-slate-500 text-slate-100 focus:outline-none focus:border-[color:var(--ac1-mid)] transition-colors"
        />
        {filter && (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setFilter("")}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 text-[14px] cursor-pointer"
          >
            ×
          </button>
        )}
      </div>
      <div
        ref={pickerRef}
        role="tablist"
        aria-label="Archive range"
        className="relative rounded-xl border border-white/5 bg-white/[0.02] p-1 grid grid-cols-6 gap-0 mx-2 mb-2"
      >
        <div
          aria-hidden
          className="absolute top-1 bottom-1 rounded-lg pointer-events-none"
          style={{
            left: ink?.left ?? 0,
            width: ink?.width ?? 0,
            background: "var(--glass-bg-selected)",
            boxShadow:
              "inset 0 1px 0 var(--glass-rim), inset 0 0 0 1px var(--ac1-mid), 0 8px 20px -10px var(--ac1-mid)",
            transition:
              "left 260ms cubic-bezier(0.34, 1.56, 0.64, 1), width 260ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 160ms ease-out",
            opacity: ink ? 1 : 0,
            zIndex: 0,
          }}
        />
        {RANGE_OPTIONS.map((opt, i) => {
          const active = digestRange === opt.value;
          const count = rangeCounts?.[rangeKey(opt.value)];
          return (
            <button
              key={String(opt.value)}
              ref={(el) => { segRefs.current[i] = el; }}
              role="tab"
              aria-label={opt.label}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setDigestRange(opt.value)}
              onKeyDown={(e) => handleRangeKeyDown(e, i)}
              className={[
                "relative z-[1] flex flex-col items-center justify-center py-1.5 rounded-lg cursor-pointer",
                "transition-[color,transform] duration-150 active:scale-[0.97]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ac1-mid)]",
                active ? "text-slate-100" : "text-slate-400 hover:text-slate-200",
              ].join(" ")}
            >
              <span className="text-[11px] font-medium leading-none">{opt.label}</span>
              <span
                className={[
                  "text-[10px] font-mono tabular-nums leading-none mt-1",
                  active ? "text-[color:var(--ac1)]" : "text-slate-500",
                ].join(" ")}
              >
                {count === undefined ? "—" : count}
              </span>
            </button>
          );
        })}
      </div>
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
        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-400">
            <div
              className="w-6 h-6 rounded-full border-2 border-white/10 animate-spin"
              style={{ borderTopColor: "var(--ac1)" }}
              aria-hidden
            />
            <div className="text-[11px] uppercase tracking-wider text-slate-500">
              Loading {digestRange === "all" ? "archive" : `${digestRange}-day range`}
            </div>
          </div>
        )}
        {!loading && papers.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <div className="text-[13px] text-slate-300 font-medium">
              No papers in this range
            </div>
            <div className="text-[11px] text-slate-500 leading-relaxed">
              {digestRange === "all"
                ? "The archive is empty. Run a daily build from the backend."
                : `No arXiv papers published in the last ${digestRange} days. Try a wider range.`}
            </div>
          </div>
        )}
        {!loading && papers.length > 0 && filteredPapers.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <div className="text-[13px] text-slate-300 font-medium">
              No matches for "{filter}"
            </div>
            <div className="text-[11px] text-slate-500">
              {papers.length} paper{papers.length === 1 ? "" : "s"} in this range didn't match.
            </div>
          </div>
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
