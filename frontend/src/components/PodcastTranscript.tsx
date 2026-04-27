import { useEffect, useRef } from "react";
import { type Segment } from "@/lib/podcastApi";

type Props = {
  segments: Segment[];
  position: number; // seconds
  onSeek: (seconds: number) => void;
};

export function PodcastTranscript({ segments, position, onSeek }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef<number>(0);
  const ignoreNextScroll = useRef(false);

  // Active segment index: where start_ms <= position*1000 < end_ms
  const positionMs = position * 1000;
  const activeIdx = segments.findIndex(
    (s) => s.start_ms <= positionMs && positionMs < s.end_ms,
  );

  // Auto-scroll the active segment into view, unless the user just scrolled.
  useEffect(() => {
    if (activeIdx < 0) return;
    const now = Date.now();
    if (now - userScrolledAt.current < 5000) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    if (!el) return;
    if (typeof el.scrollIntoView !== "function") return;
    ignoreNextScroll.current = true;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  if (segments.length === 0) return null;

  const onScroll = () => {
    if (ignoreNextScroll.current) {
      ignoreNextScroll.current = false;
      return;
    }
    userScrolledAt.current = Date.now();
  };

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="max-h-64 overflow-y-auto flex flex-col gap-1 p-2 text-sm border-t border-[var(--glass-border)]"
    >
      {segments.map((seg) => (
        <button
          key={seg.idx}
          data-idx={seg.idx}
          data-active={seg.idx === activeIdx ? "true" : undefined}
          type="button"
          onClick={() => onSeek(seg.start_ms / 1000)}
          className={
            "text-left rounded px-2 py-1 transition-colors " +
            (seg.idx === activeIdx
              ? "bg-[var(--ac1-soft)] text-[var(--ac1)]"
              : "text-slate-300 hover:bg-white/5")
          }
        >
          {seg.text}
        </button>
      ))}
    </div>
  );
}
