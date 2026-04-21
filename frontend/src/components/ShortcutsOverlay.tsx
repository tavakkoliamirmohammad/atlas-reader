import { createPortal } from "react-dom";
import { SHORTCUTS } from "@/lib/keyboard";

type Props = { open: boolean; onClose: () => void };

export function ShortcutsOverlay({ open, onClose }: Props) {
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="glass-elevated w-[min(520px,90vw)] rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium text-zinc-100">Keyboard shortcuts</h2>
          <button onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-200" aria-label="Close">Esc</button>
        </div>
        <ul className="space-y-2">
          {SHORTCUTS.map((s) => (
            <li key={s.combo} className="flex items-center justify-between text-sm">
              <span className="text-zinc-300">{s.label}</span>
              <kbd className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-200">{s.combo}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
