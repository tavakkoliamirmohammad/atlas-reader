import { useUiStore } from "@/stores/ui-store";
import { Menu, MessageSquare } from "lucide-react";

export function PanelToggles() {
  const toggleLeft = useUiStore((s) => s.toggleLeft);
  const toggleRight = useUiStore((s) => s.toggleRight);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label="Toggle left panel"
        onClick={toggleLeft}
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md bg-white/[0.04] border border-white/5 text-slate-300 hover:text-white hover:border-[color:var(--ac1-mid)] transition-colors"
      >
        <Menu size={12} /> List
        <kbd className="px-1 border border-white/15 rounded text-[10px] font-mono">[</kbd>
      </button>
      <button
        type="button"
        aria-label="Toggle right panel"
        onClick={toggleRight}
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md bg-white/[0.04] border border-white/5 text-slate-300 hover:text-white hover:border-[color:var(--ac1-mid)] transition-colors"
      >
        Chat <MessageSquare size={12} />
        <kbd className="px-1 border border-white/15 rounded text-[10px] font-mono">]</kbd>
      </button>
    </div>
  );
}
