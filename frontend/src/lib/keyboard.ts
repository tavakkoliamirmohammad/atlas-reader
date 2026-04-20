import { useEffect } from "react";
import { useUiStore } from "@/stores/ui-store";

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
}

export function useGlobalShortcuts() {
  const toggleLeft = useUiStore((s) => s.toggleLeft);
  const toggleRight = useUiStore((s) => s.toggleRight);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[") { e.preventDefault(); toggleLeft(); }
      else if (e.key === "]") { e.preventDefault(); toggleRight(); }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleLeft, toggleRight]);
}
