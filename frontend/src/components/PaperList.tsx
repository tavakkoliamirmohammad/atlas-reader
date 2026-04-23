import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type Paper } from "@/lib/api";
import { groupPapersByDay } from "@/lib/group-by-day";
import { useUiStore, type DigestRange } from "@/stores/ui-store";
import { UrlBar } from "./UrlBar";
import { PaperRow } from "./PaperRow";

const RANGE_OPTIONS: { value: DigestRange; label: string }[] = [
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

export function PaperList() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rangeCounts, setRangeCounts] = useState<RangeCounts | null>(null);
  const [filter, setFilter] = useState("");
  // Days the user has collapsed. Keyed by isoDate so a given day stays collapsed
  // across re-renders. Reset on range switch because the dayGroups themselves
  // change shape — keeping stale keys around is harmless but clearing makes the
  // UX predictable ("switch range → everything is open").
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(() => new Set());
  // Briefly flashed day after a date-pill jump — gives the user a visual
  // anchor at the new scroll position. Cleared by a timeout so the flash
  // plays once per click.
  const [flashingDay, setFlashingDay] = useState<string | null>(null);
  // The pill the user clicked most recently. Drives pill-highlight state in
  // the date-jumper strip — clears when the user switches range (data
  // changes, old selection no longer meaningful).
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // When `jumpToDay` bumps activeIndex to the first paper of a target day,
  // it handles the scrolling manually (smooth, to the day header). We want
  // the activeIndex-driven scroll-into-view effect to sit this one out —
  // otherwise it fires after React re-renders, calls scrollIntoView with
  // default (instant) behavior, cancels our smooth scroll, and lands on
  // "nearest" position instead of the top of the day.
  const skipNextActiveScrollRef = useRef(false);
  // Cancels a rAF-driven jump-to-day animation if the user clicks a new
  // pill mid-scroll. Without this, two overlapping rAF loops fight and
  // the scroll jitters.
  const animateScrollRef = useRef<(() => void) | null>(null);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const segRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null);
  const digestRange = useUiStore((s) => s.digestRange);
  const setDigestRange = useUiStore((s) => s.setDigestRange);

  // Reset filter when the user switches range so "no results" in 3d doesn't
  // silently hide all 30d papers too.
  useEffect(() => {
    setFilter("");
    setCollapsedDays(new Set());
    setSelectedDay(null);
  }, [digestRange]);

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

  // Client-side filter: title + authors (case-insensitive substring).
  const filteredPapers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return papers;
    return papers.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.authors.toLowerCase().includes(q),
    );
  }, [papers, filter]);

  // Memoize so dayGroups keeps a stable reference between renders (only
  // changes when filteredPapers changes). Without this, the derived
  // `flatPapers` also re-references every render, causing the activeIndex
  // scroll-into-view effect to fire on every re-render (setFlashingDay,
  // etc.) and fight our rAF jumpToDay animation.
  const dayGroups = useMemo(() => groupPapersByDay(filteredPapers), [filteredPapers]);

  // Flat row order for arrow-key nav across the day groups. Collapsed days are
  // excluded so ↓/↑ skips hidden rows instead of moving through invisible items.
  const flatPapers = useMemo<Paper[]>(
    () => dayGroups.flatMap((g) => (collapsedDays.has(g.isoDate) ? [] : g.papers)),
    [dayGroups, collapsedDays],
  );

  function toggleDayCollapsed(isoDate: string) {
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(isoDate)) next.delete(isoDate);
      else next.add(isoDate);
      return next;
    });
  }

  // Jump the list scroll position to a specific day's header. If the day is
  // currently collapsed, expand it first — the user's intent with "jump to
  // date" is "show me this day."
  //
  // We also MOVE activeIndex to the first paper of that day. This is not
  // cosmetic: the `activeIndex` effect below also scrolls its row into view.
  // If we scroll the container to isoDate but leave activeIndex=0, that
  // effect fires on re-render (from setFlashingDay) and immediately scrolls
  // the container back to the top — which looks like "click did nothing."
  // Moving activeIndex eliminates that race and is semantically right:
  // clicking a date should focus-land on that day's first paper.
  function jumpToDay(isoDate: string) {
    setSelectedDay(isoDate);
    setCollapsedDays((prev) => {
      if (!prev.has(isoDate)) return prev;
      const next = new Set(prev);
      next.delete(isoDate);
      return next;
    });
    // Find the flat index of the first paper in this day group.
    const dayGroup = dayGroups.find((g) => g.isoDate === isoDate);
    const firstPaper = dayGroup?.papers[0];
    if (firstPaper) {
      const idx = flatPapers.indexOf(firstPaper);
      if (idx >= 0) {
        skipNextActiveScrollRef.current = true;
        setActiveIndex(idx);
      }
    }
    requestAnimationFrame(() => {
      const container = listRef.current;
      if (!container) return;
      // Direct dataset lookup avoids the CSS.escape pitfall: isoDate starts
      // with a digit ("2026-…") which CSS.escape encodes as a hex escape
      // that some browsers mishandle in attribute selectors.
      let el: HTMLElement | null = null;
      for (const candidate of container.querySelectorAll<HTMLElement>("[data-day]")) {
        if (candidate.dataset.day === isoDate) {
          el = candidate;
          break;
        }
      }
      if (!el) return;
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const target = Math.max(
        0,
        container.scrollTop + (elRect.top - containerRect.top),
      );
      // Custom smooth scroll: Chrome's native `behavior: "smooth"`
      // undershoots long jumps (observed ~400px short on a ~19k distance)
      // and any correction mid-flight reads as a jump. Our own rAF loop
      // with cubic-out easing lands on the exact target, consistently.
      animateScrollRef.current?.();
      const start = container.scrollTop;
      const distance = target - start;
      if (Math.abs(distance) > 1) {
        const duration = Math.min(600, 260 + Math.abs(distance) * 0.04);
        const t0 = performance.now();
        let rafId = 0;
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / duration);
          const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
          container.scrollTop = start + distance * eased;
          if (t < 1) rafId = requestAnimationFrame(step);
          else animateScrollRef.current = null;
        };
        rafId = requestAnimationFrame(step);
        animateScrollRef.current = () => cancelAnimationFrame(rafId);
      }
      setFlashingDay(isoDate);
      window.setTimeout(() => {
        setFlashingDay((cur) => (cur === isoDate ? null : cur));
      }, 900);
    });
  }

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

  // Scroll the active row into view when it changes — unless jumpToDay just
  // set activeIndex itself (it handles scrolling manually with smooth
  // behavior to land the day header at the container top).
  useEffect(() => {
    if (skipNextActiveScrollRef.current) {
      skipNextActiveScrollRef.current = false;
      return;
    }
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
        <div className="text-[11px] uppercase tracking-wider text-slate-400">Today {"\u00b7"} {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
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
            className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-[14px] cursor-pointer"
          >
            ×
          </button>
        )}
      </div>
      <div
        ref={pickerRef}
        role="tablist"
        aria-label="Archive range"
        className="relative rounded-xl border border-white/5 bg-white/[0.02] p-1 grid grid-cols-5 gap-0 mx-2 mb-2"
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
      {dayGroups.length > 1 && (
        <div
          role="toolbar"
          aria-label="Jump to date"
          className="date-jumper px-2 pb-2 overflow-x-auto"
        >
          <div className="flex gap-1.5 w-max">
            {dayGroups.map((g) => {
              // Fall back to the first (most recent) day when nothing has
              // been clicked yet, so there's always a visual anchor.
              const active = selectedDay
                ? g.isoDate === selectedDay
                : g.isoDate === dayGroups[0]?.isoDate;
              return (
                <button
                  key={g.isoDate}
                  type="button"
                  aria-pressed={active}
                  onClick={(e) => {
                    jumpToDay(g.isoDate);
                    // Keep the clicked pill in view: scroll only the strip
                    // (block:"nearest" avoids any vertical page shift since
                    // the pill is already vertically visible).
                    e.currentTarget.scrollIntoView({
                      behavior: "smooth",
                      inline: "center",
                      block: "nearest",
                    });
                  }}
                  title={`Jump to ${g.dateLabel} (${g.count} paper${g.count === 1 ? "" : "s"})`}
                  className={[
                    "px-2 py-1 rounded-full text-[11px] whitespace-nowrap flex-shrink-0 cursor-pointer transition-colors",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--ac1-mid)]",
                    active
                      ? "text-[color:var(--ac1)] bg-[color:var(--ac1-soft)] border border-[color:var(--ac1-mid)] shadow-[0_0_10px_var(--ac1-mid)] hover:brightness-110"
                      : "text-slate-300 bg-white/[0.03] border border-white/5 hover:bg-white/[0.08] hover:text-white hover:border-[color:var(--ac1-mid)]",
                  ].join(" ")}
                >
                  <span>{g.dateLabel}</span>
                  <span className="ml-1 font-mono tabular-nums opacity-70">{g.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
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
            <div className="text-[11px] uppercase tracking-wider text-slate-400">
              Loading {digestRange === "all" ? "archive" : `${digestRange}-day range`}
            </div>
          </div>
        )}
        {!loading && papers.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <div className="text-[13px] text-slate-300 font-medium">
              No papers in this range
            </div>
            <div className="text-[11px] text-slate-400 leading-relaxed">
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
            <div className="text-[11px] text-slate-400">
              {papers.length} paper{papers.length === 1 ? "" : "s"} in this range didn't match.
            </div>
          </div>
        )}
        {dayGroups.map((g) => {
          const collapsed = collapsedDays.has(g.isoDate);
          return (
            <div key={g.isoDate} data-day={g.isoDate} role="group" aria-label={g.dateLabel}>
              <button
                type="button"
                onClick={() => toggleDayCollapsed(g.isoDate)}
                aria-expanded={!collapsed}
                aria-controls={`day-${g.isoDate}`}
                className={[
                  "w-full px-3 pt-2.5 pb-1 text-[11px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5 cursor-pointer hover:text-slate-300 transition-colors focus-visible:outline-none focus-visible:text-slate-200",
                  flashingDay === g.isoDate ? "day-flash" : "",
                ].join(" ")}
              >
                {collapsed
                  ? <ChevronRight size={12} className="text-slate-400" aria-hidden />
                  : <ChevronDown size={12} className="text-slate-400" aria-hidden />}
                <span>{g.dateLabel} ({g.count})</span>
              </button>
              {!collapsed && (
                <div id={`day-${g.isoDate}`}>
                  {g.papers.map((p) => {
                    const flatIdx = flatPapers.indexOf(p);
                    return (
                      <PaperRow
                        key={p.arxiv_id}
                        paper={p}
                        enterIndex={flatIdx}
                        isActiveRow={flatIdx === activeIndex}
                        onFocusRequest={() => setActiveIndex(flatIdx)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
