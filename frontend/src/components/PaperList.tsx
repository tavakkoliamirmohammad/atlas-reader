import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, RefreshCcw } from "lucide-react";
import { api, type DigestFailure, type Paper } from "@/lib/api";
import { groupPapersByDay } from "@/lib/group-by-day";
import { useUiStore, type DigestRange } from "@/stores/ui-store";
import { UrlBar } from "./UrlBar";
import { PaperRow } from "./PaperRow";
import { CategoryPicker } from "./CategoryPicker";

const RANGE_OPTIONS: { value: DigestRange; label: string }[] = [
  { value: 3,  label: "3d" },
  { value: 7,  label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
];

type FetchOutcome =
  | { kind: "ok" }
  | { kind: "rate_limited" }
  | { kind: "unreachable" }
  | { kind: "error"; detail: string };

type RangeData = { papers: Paper[]; outcome: FetchOutcome };

function summarizeFailures(failures: DigestFailure[] | undefined, papers: number): FetchOutcome {
  if (!failures || failures.length === 0 || papers > 0) return { kind: "ok" };
  // If at least one category was rate-limited, that's almost always the
  // root cause for the others too — surface the most informative banner.
  if (failures.some((f) => f.kind === "rate_limited")) return { kind: "rate_limited" };
  if (failures.some((f) => f.kind === "unreachable")) return { kind: "unreachable" };
  return { kind: "error", detail: failures[0].kind };
}

// Cache key folds the active categories AND the range together. Switching
// categories produces a new key (no cache hit), so changes invalidate
// implicitly — no separate invalidation pass needed. Sorted so equivalent
// category sets in different orders share a key.
function cacheKey(categories: readonly string[], range: DigestRange): string {
  return `${[...categories].sort().join(",")}|${range}`;
}

export function PaperList() {
  // Per-range cache so switching back to an already-fetched range is
  // instant. Key folds in `digestCategories` so toggling cats invalidates
  // implicitly: a new key means no cache hit, the fetch effect refires,
  // and the stale entries simply linger unused (bounded by # cat-combos
  // × 5 ranges, which in practice stays small).
  const [cache, setCache] = useState<Map<string, RangeData>>(() => new Map());
  // `fetching` = "a refetch is in flight". When we have nothing for this
  // (cats, range) yet, the list area shows a clear loading state; when we
  // do have data, the active pill spinner is enough.
  const [fetching, setFetching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshInfo, setRefreshInfo] = useState<string | null>(null);
  const refreshInfoTimerRef = useRef<number | null>(null);
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
  const digestCategories = useUiStore((s) => s.digestCategories);
  const setDigestCategories = useUiStore((s) => s.setDigestCategories);

  // Derived view state from the cache: a hit means "we already have data
  // for this (cats, range) — show it instantly"; a miss means "show the
  // list-area loading state and fetch."
  const currentKey = useMemo(
    () => cacheKey(digestCategories, digestRange),
    [digestCategories, digestRange],
  );
  const current = cache.get(currentKey);
  const papers = current?.papers ?? [];
  const outcome = current?.outcome ?? { kind: "ok" };
  const loading = current === undefined && digestCategories.length > 0;

  // Reset per-range UI bookkeeping when the user switches range so "no
  // results" in 3d doesn't silently hide all 30d papers too.
  useEffect(() => {
    setFilter("");
    setCollapsedDays(new Set());
    setSelectedDay(null);
  }, [digestRange]);

  // Fetch when the (cats, range) pair has no cached data. Switching back
  // to an already-loaded range is a no-op (instant render). A debounce
  // protects against rapid toggling in the category picker.
  //
  // The cleanup function aborts the in-flight network request via
  // AbortController so a quick range/category switch doesn't pile up
  // overlapping fetches against the arXiv endpoint (which throttles
  // aggressively). Without this, holding ↔ on the range strip could
  // produce N concurrent requests and trip a 429.
  useEffect(() => {
    if (digestCategories.length === 0) return;
    if (cache.has(currentKey)) return;

    const ac = new AbortController();
    let cancelled = false;
    setFetching(true);
    const t = window.setTimeout(async () => {
      try {
        // Send the active range to the backend so the arXiv query scopes
        // to that window — a 3-day filter no longer pulls 100 papers
        // per category just to discard most of them client-side.
        const res = await api.digest(digestCategories, false, digestRange, ac.signal);
        if (cancelled) return;
        const o = summarizeFailures(res.failures, res.papers.length);
        setCache((prev) => {
          const next = new Map(prev);
          next.set(currentKey, { papers: res.papers, outcome: o });
          return next;
        });
      } catch (e) {
        if (cancelled) return;
        // AbortError means the user navigated away mid-flight; drop
        // it silently rather than showing a "failed" state.
        if ((e as Error).name === "AbortError") return;
        setCache((prev) => {
          const next = new Map(prev);
          next.set(currentKey, {
            papers: [],
            outcome: { kind: "error", detail: (e as Error).message },
          });
          return next;
        });
      } finally {
        if (!cancelled) setFetching(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      ac.abort();
    };
    // `cache` intentionally not a dep — we only want to refetch on a
    // (cats, range) miss, not on every cache write (that would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, digestCategories, digestRange]);

  // Clear any pending "refresh info" flash on unmount so the timer doesn't
  // fire after the component is gone.
  useEffect(() => {
    return () => {
      if (refreshInfoTimerRef.current !== null) {
        window.clearTimeout(refreshInfoTimerRef.current);
      }
    };
  }, []);

  function flashRefreshInfo(msg: string) {
    setRefreshInfo(msg);
    if (refreshInfoTimerRef.current !== null) {
      window.clearTimeout(refreshInfoTimerRef.current);
    }
    refreshInfoTimerRef.current = window.setTimeout(() => {
      setRefreshInfo(null);
      refreshInfoTimerRef.current = null;
    }, 3000);
  }

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    const before = papers.length;
    try {
      // `fresh=true` bypasses the backend's per-category TTL cache so the
      // user actually sees the latest arXiv state when they hit the
      // refresh button (otherwise we'd hand them the cached snapshot).
      // `digestRange` matters here too — refreshing the 3-day view should
      // refetch 3 days, not the unscoped slice.
      const res = await api.digest(digestCategories, true, digestRange);
      const delta = res.papers.length - before;
      const o = summarizeFailures(res.failures, res.papers.length);
      setCache((prev) => {
        const next = new Map(prev);
        next.set(currentKey, { papers: res.papers, outcome: o });
        return next;
      });
      if (o.kind === "rate_limited") {
        flashRefreshInfo("arXiv is rate-limiting us — try again in a few minutes");
      } else if (o.kind === "unreachable") {
        flashRefreshInfo("Couldn't reach arXiv — check your connection");
      } else {
        flashRefreshInfo(
          delta > 0
            ? `${delta} new paper${delta === 1 ? "" : "s"}`
            : "Already up to date",
        );
      }
    } catch (e) {
      flashRefreshInfo(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

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

  // Client-side filter on the cached list: belt-and-suspenders date filter
  // (the backend already scopes the arXiv query, so this is a defensive
  // crop) + text (title/authors).
  const filteredPapers = useMemo(() => {
    const cutoffMs = Date.now() - digestRange * 24 * 60 * 60 * 1000;
    let scoped = papers.filter((p) => new Date(p.published).getTime() >= cutoffMs);
    const q = filter.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.authors.toLowerCase().includes(q),
    );
  }, [papers, digestRange, filter]);

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
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Today {"\u00b7"} {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
          <div className="flex items-center gap-1">
            <CategoryPicker
              selected={digestCategories}
              onChange={setDigestCategories}
            />
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title="Refresh from arXiv"
              aria-label="Refresh from arXiv"
              className="rounded p-1 text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] disabled:opacity-50 transition-colors cursor-pointer"
            >
              <RefreshCcw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                aria-hidden
              />
            </button>
          </div>
        </div>
        {refreshInfo && (
          <div role="status" className="mt-1 text-[10px] text-slate-400">
            {refreshInfo}
          </div>
        )}
        {fetching && !loading && (
          <div role="status" className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-400">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full pulse-dot"
              style={{ background: "var(--ac1)" }}
              aria-hidden
            />
            Updating…
          </div>
        )}
      </div>
      <UrlBar onSubmit={(id) => navigate(`/reader/${id}`)} />
      <div className="px-2 pb-2 relative">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter in range…"
          aria-label="Filter papers in current range"
          className={`w-full text-[12px] py-1.5 rounded-lg bg-white/[0.03] border border-white/5 placeholder:text-slate-500 text-slate-100 focus:outline-none focus:border-[color:var(--ac1-mid)] transition-colors ${filter ? "pl-2.5 pr-7" : "px-2.5"}`}
        />
        {filter && (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setFilter("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] text-[14px] leading-none cursor-pointer transition-colors"
          >
            ×
          </button>
        )}
      </div>
      <div
        ref={pickerRef}
        role="tablist"
        aria-label="Archive range"
        className="relative rounded-xl border border-white/5 bg-white/[0.02] p-1 grid grid-cols-4 gap-0 mx-2 mb-2"
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
          // Look up THIS pill's range in the cache. Any range the user has
          // already visited (under the current category set) shows its
          // real count immediately — no second arXiv round trip. Ranges
          // we've never fetched stay label-only because we genuinely
          // don't know their count yet.
          const entry = cache.get(cacheKey(digestCategories, opt.value));
          const showSpinner = active && fetching && entry === undefined;
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
                  "text-[10px] font-mono tabular-nums leading-none mt-1 h-3",
                  active ? "text-[color:var(--ac1)]" : "text-slate-500",
                ].join(" ")}
              >
                {showSpinner ? (
                  <span
                    className="inline-block w-2 h-2 rounded-full border border-white/20 animate-spin"
                    style={{ borderTopColor: "var(--ac1)" }}
                    aria-label="Loading"
                  />
                ) : entry !== undefined ? (
                  entry.papers.length
                ) : null}
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
          <div
            className="flex flex-col gap-2 py-4 px-2"
            role="status"
            aria-live="polite"
            aria-label={`Loading ${digestRange}d range`}
          >
            <div className="flex items-center justify-center gap-2 py-3 text-slate-400">
              <div
                className="w-4 h-4 rounded-full border-2 border-white/10 animate-spin"
                style={{ borderTopColor: "var(--ac1)" }}
                aria-hidden
              />
              <div className="text-[11px] uppercase tracking-wider">
                Fetching arXiv · {digestRange}d
              </div>
            </div>
            {/* Skeleton rows give the eye somewhere to rest while the fetch
                is in flight, and signal "this is the list area" so the user
                isn't unsure where the result will appear. */}
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-white/5 px-3 py-2.5 animate-pulse"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <div className="h-3 w-3/4 rounded bg-white/10" />
                <div className="mt-2 h-2.5 w-1/2 rounded bg-white/5" />
              </div>
            ))}
          </div>
        )}
        {!loading && papers.length === 0 && digestCategories.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <div className="text-[13px] text-slate-300 font-medium">
              No categories selected
            </div>
            <div className="text-[11px] text-slate-400 leading-relaxed">
              Click the cats button above and pick at least one to see papers.
            </div>
          </div>
        )}
        {!loading && papers.length === 0 && digestCategories.length > 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            {outcome.kind === "rate_limited" ? (
              <>
                <div className="text-[13px] text-amber-200 font-medium">
                  arXiv is rate-limiting us
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  Their API throttles bursts. Wait a few minutes and hit refresh.
                </div>
              </>
            ) : outcome.kind === "unreachable" ? (
              <>
                <div className="text-[13px] text-amber-200 font-medium">
                  Couldn't reach arXiv
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  Check your connection, then hit refresh.
                </div>
              </>
            ) : outcome.kind === "error" ? (
              <>
                <div className="text-[13px] text-rose-200 font-medium">
                  Couldn't load papers
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  {outcome.detail}
                </div>
              </>
            ) : (
              <>
                <div className="text-[13px] text-slate-300 font-medium">
                  No papers in the last {digestRange} days
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed max-w-xs">
                  arXiv had nothing for these categories in this window.
                  Try a wider range, more categories, or refresh.
                </div>
                <div className="flex gap-2 mt-2">
                  {digestRange !== 30 && (
                    <button
                      type="button"
                      onClick={() => setDigestRange(30)}
                      className="px-3 py-1.5 text-[11px] rounded-md border border-white/15 hover:border-[color:var(--ac1-mid)] hover:text-slate-100 transition-colors cursor-pointer"
                    >
                      Widen to 30d
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onRefresh}
                    disabled={refreshing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-md border border-white/15 hover:border-[color:var(--ac1-mid)] hover:text-slate-100 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCcw size={12} className={refreshing ? "animate-spin" : ""} />
                    Refresh
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {!loading && papers.length > 0 && filteredPapers.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            {filter.trim() ? (
              <>
                <div className="text-[13px] text-slate-300 font-medium">
                  No matches for "{filter}"
                </div>
                <div className="text-[11px] text-slate-400">
                  {papers.length} paper{papers.length === 1 ? "" : "s"} fetched didn't match.
                </div>
              </>
            ) : (
              <>
                <div className="text-[13px] text-slate-300 font-medium">
                  Nothing in the last {digestRange} days
                </div>
                <div className="text-[11px] text-slate-400">
                  Try a wider range — {papers.length} paper{papers.length === 1 ? "" : "s"} fetched in total.
                </div>
              </>
            )}
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
