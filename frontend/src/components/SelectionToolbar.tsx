import { useEffect, useState } from "react";
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
 * Floating 2-button toolbar pinned above the last selection rect. Lets the
 * user persist a highlight (in the chosen color) or pin the quote into the
 * chat panel to ask about it.
 */
export function SelectionToolbar({ left, top, color, onHighlight, onAsk }: Props) {
  const [current, setCurrent] = useState<HighlightColor>(color);

  // Sync when the parent's default color changes between selections.
  useEffect(() => { setCurrent(color); }, [color]);

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
      onMouseDown={(e) => {
        // Keep the underlying text selection alive while the user clicks
        // the toolbar — default mousedown on the toolbar would collapse it.
        e.preventDefault();
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
