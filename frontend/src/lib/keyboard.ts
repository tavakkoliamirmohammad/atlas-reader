import { useEffect, useRef } from "react";

type Handler = (e: KeyboardEvent) => void;
type Registered = { combo: string; handler: Handler };

const listeners = new Set<Registered>();
let seq: string[] = [];
let seqTimer: ReturnType<typeof setTimeout> | null = null;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return false;
}

function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && e.key.length > 1) parts.push("shift");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

function onKeydown(e: KeyboardEvent) {
  if (isEditable(e.target)) return;
  const combo = comboFromEvent(e);

  for (const l of listeners) {
    if (l.combo === combo) {
      e.preventDefault();
      l.handler(e);
      seq = [];
      return;
    }
  }

  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key.length !== 1 && key !== "escape") return;
  seq.push(key);
  if (seqTimer) clearTimeout(seqTimer);
  seqTimer = setTimeout(() => { seq = []; }, 800);

  const seqStr = seq.join(" ");
  for (const l of listeners) {
    if (l.combo === seqStr) {
      e.preventDefault();
      l.handler(e);
      seq = [];
      return;
    }
  }
}

let installed = false;
export function installKeyboard() {
  if (installed) return;
  window.addEventListener("keydown", onKeydown);
  installed = true;
}

export function useShortcut(combo: string, handler: Handler, deps: unknown[] = []) {
  const ref = useRef<Handler>(handler);
  ref.current = handler;
  useEffect(() => {
    const entry: Registered = { combo, handler: (e) => ref.current(e) };
    listeners.add(entry);
    return () => { listeners.delete(entry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combo, ...deps]);
}

export const SHORTCUTS: Array<{ combo: string; label: string }> = [
  { combo: "[",      label: "Toggle left panel" },
  { combo: "]",      label: "Toggle right panel" },
  { combo: "s",      label: "Summarize current paper" },
  { combo: "/",      label: "Focus URL bar" },
  { combo: "?",      label: "Show shortcuts overlay" },
  { combo: "mod+k",  label: "Open command palette" },
  { combo: "escape", label: "Close overlay" },
];
