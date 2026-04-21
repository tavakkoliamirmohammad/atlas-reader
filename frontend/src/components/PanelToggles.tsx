import { useUiStore } from "@/stores/ui-store";
import { PanelLeft, PanelRight } from "lucide-react";

/**
 * Icon-only panel toggles. The `[` and `]` keyboard shortcuts still work;
 * these are just the mouse affordance, kept compact to not crowd the top bar.
 */
export function PanelToggles() {
  const toggleLeft = useUiStore((s) => s.toggleLeft);
  const toggleRight = useUiStore((s) => s.toggleRight);
  const leftCollapsed = useUiStore((s) => s.leftCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightCollapsed);

  const btn =
    "inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/[0.04] border border-white/5 text-slate-300 hover:text-slate-100 hover:border-[color:var(--ac1-mid)] transition-colors cursor-pointer";

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Toggle left panel"
        title={leftCollapsed ? "Show paper list ([)" : "Hide paper list ([)"}
        onClick={toggleLeft}
        className={btn}
      >
        <PanelLeft size={13} />
      </button>
      <button
        type="button"
        aria-label="Toggle right panel"
        title={rightCollapsed ? "Show chat (])" : "Hide chat (])"}
        onClick={toggleRight}
        className={btn}
      >
        <PanelRight size={13} />
      </button>
    </div>
  );
}
