import { Moon, Sun } from "lucide-react";
import { useUiStore } from "@/stores/ui-store";

export function AppModeToggle() {
  const appMode = useUiStore((s) => s.appMode);
  const toggle = useUiStore((s) => s.toggleAppMode);
  const isDark = appMode === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/[0.04] border border-white/5 text-slate-300 hover:text-slate-100 hover:border-[color:var(--ac1-mid)] transition-colors cursor-pointer"
    >
      {isDark ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  );
}
