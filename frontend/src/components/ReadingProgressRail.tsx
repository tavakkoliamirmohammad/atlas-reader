import { useMemo, useState } from "react";

/**
 * Section marker on the reading rail. `pageIndex` is zero-based to match the
 * shape we accept from PDF outlines. `depth` lets us render top-level sections
 * larger than nested ones.
 */
export type RailSection = {
  title: string;
  pageIndex: number;
  depth?: number;
};

export type ReadingProgress = {
  /** 1-based current visible page. */
  current: number;
  /** Total pages in the document. */
  total: number;
  /**
   * Optional fine-grained scroll progress (0..1). When provided, the filled
   * portion of the rail tracks scroll continuously instead of snapping to the
   * page boundary — feels much smoother for long pages.
   */
  scrollRatio?: number;
  /** Optional outline / bookmark markers. */
  sections?: RailSection[];
};

type Props = {
  /**
   * Fully-resolved reading progress. Pass `null` if the underlying PDF surface
   * doesn't expose page/outline info — the rail renders as a quiet decoration.
   */
  progress: ReadingProgress | null;
  /** Click a marker to jump to that page (1-based). */
  onJumpToPage?: (pageNumber: number) => void;
};

export function ReadingProgressRail({ progress, onJumpToPage }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);

  const isStatic = !progress || progress.total <= 0;

  const fillPct = useMemo(() => {
    if (!progress || progress.total <= 0) return 0;
    if (typeof progress.scrollRatio === "number") {
      return Math.max(0, Math.min(1, progress.scrollRatio)) * 100;
    }
    if (progress.total <= 1) return progress.total === 1 ? 100 : 0;
    const ratio = (progress.current - 1) / (progress.total - 1);
    return Math.max(0, Math.min(1, ratio)) * 100;
  }, [progress]);

  const sections = progress?.sections ?? [];
  const total = progress?.total ?? 0;
  const current = progress?.current ?? 1;

  return (
    <div
      className="absolute left-1.5 top-3 bottom-3 z-10 pointer-events-none"
      style={{ width: 14 }}
      aria-hidden={isStatic}
    >
      <div className="relative h-full w-[3px] mx-auto rounded-full bg-white/5 overflow-visible">
        {/* Filled portion */}
        <div
          className="absolute left-0 right-0 top-0 rounded-full bg-gradient-to-b from-[var(--ac1)] to-[var(--ac2)] transition-[height] duration-200 ease-out"
          style={{
            height: `${isStatic ? 0 : fillPct}%`,
            boxShadow:
              "0 0 6px rgba(var(--ac1-rgb), 0.55), 0 0 14px rgba(var(--ac2-rgb), 0.25)",
          }}
        />

        {/* Section markers */}
        {!isStatic &&
          total > 1 &&
          sections.map((m, i) => {
            const denom = total - 1;
            const top = denom > 0 ? (m.pageIndex / denom) * 100 : 0;
            const clamped = Math.max(0, Math.min(100, top));
            const reached = m.pageIndex + 1 <= current;
            const isHovered = hovered === i;
            const depth = m.depth ?? 0;
            return (
              <button
                key={`${m.pageIndex}-${i}`}
                type="button"
                onClick={() => onJumpToPage?.(m.pageIndex + 1)}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() =>
                  setHovered((cur) => (cur === i ? null : cur))
                }
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered((cur) => (cur === i ? null : cur))}
                className="pointer-events-auto absolute -translate-y-1/2 -translate-x-1/2 left-1/2"
                style={{ top: `${clamped}%` }}
                aria-label={`Jump to ${m.title} (page ${m.pageIndex + 1})`}
                title={m.title}
              >
                <span
                  className="block rounded-full transition-all duration-150"
                  style={{
                    width: depth === 0 ? 7 : 5,
                    height: depth === 0 ? 7 : 5,
                    background: reached
                      ? "linear-gradient(180deg, var(--ac1), var(--ac2))"
                      : "rgba(255,255,255,0.45)",
                    boxShadow: isHovered
                      ? "0 0 0 2px rgba(255,255,255,0.18), 0 0 8px rgba(var(--ac1-rgb),0.7)"
                      : reached
                        ? "0 0 6px rgba(var(--ac1-rgb),0.55)"
                        : "0 0 0 1px rgba(255,255,255,0.15)",
                    transform: isHovered ? "scale(1.35)" : "scale(1)",
                  }}
                />
                {isHovered && (
                  <span
                    className="absolute left-[14px] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[11px] leading-none text-white/90 ring-1 ring-white/10 backdrop-blur-md"
                    style={{
                      background: "rgba(20,22,30,0.85)",
                      maxWidth: 280,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <span className="opacity-60 mr-1">p.{m.pageIndex + 1}</span>
                    {m.title}
                  </span>
                )}
              </button>
            );
          })}
      </div>
    </div>
  );
}

export default ReadingProgressRail;
