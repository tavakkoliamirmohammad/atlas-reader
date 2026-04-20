import { Sun, Book, Moon, ChevronLeft, ChevronRight, Plus, Minus, Download } from "lucide-react";
import type { ReadingMode } from "@/stores/ui-store";

type Props = {
  arxivId: string;
  page: number;
  pageCount: number;
  scale: number;
  mode: ReadingMode;
  onPrev: () => void;
  onNext: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onModeChange: (m: ReadingMode) => void;
};

export function PdfToolbar(p: Props) {
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-2 rounded-full bg-[rgba(18,18,28,0.78)] backdrop-blur-xl border border-white/10 shadow-2xl text-xs text-slate-300">
      <button onClick={p.onPrev} aria-label="Previous page" className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10"><ChevronLeft size={14} /></button>
      <span className="font-mono text-[color:var(--ac1)] text-[11px] px-1">arXiv:{p.arxivId}</span>
      <span className="w-px h-3.5 bg-white/10" />
      <span className="px-1 tabular-nums text-slate-400">{p.page} / {p.pageCount || "?"}</span>
      <button onClick={p.onNext} aria-label="Next page" className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10"><ChevronRight size={14} /></button>
      <span className="w-px h-3.5 bg-white/10" />
      <button onClick={p.onZoomOut} aria-label="Zoom out" className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10"><Minus size={14} /></button>
      <span className="px-1 tabular-nums text-slate-400">{Math.round(p.scale * 100)}%</span>
      <button onClick={p.onZoomIn} aria-label="Zoom in" className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10"><Plus size={14} /></button>
      <span className="w-px h-3.5 bg-white/10" />
      {(["light", "sepia", "dark"] as ReadingMode[]).map((m) => {
        const Icon = m === "light" ? Sun : m === "sepia" ? Book : Moon;
        const active = m === p.mode;
        return (
          <button
            key={m}
            onClick={() => p.onModeChange(m)}
            aria-label={`${m} reading mode`}
            aria-pressed={active}
            className={[
              "px-2 py-0.5 rounded-full text-[11px] flex items-center gap-1 transition-colors",
              active
                ? "text-[color:var(--ac1)] border border-[color:var(--ac1-mid)] bg-[color:var(--ac1-soft)]"
                : "text-slate-400 border border-transparent hover:text-white hover:border-white/10",
            ].join(" ")}
          >
            <Icon size={12} /> {m[0].toUpperCase() + m.slice(1)}
          </button>
        );
      })}
      <span className="w-px h-3.5 bg-white/10" />
      <a href={`/api/pdf/${p.arxivId}`} download aria-label="Download PDF" className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10"><Download size={14} /></a>
    </div>
  );
}
