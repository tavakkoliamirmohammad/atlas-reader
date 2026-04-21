import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Props = { open: boolean; date: string; onDone: () => void };

export function BuildProgressOverlay({ open, date, onDone }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLines([]); setFinalStatus(null);
    const src = new EventSource(`/api/build-progress?date=${encodeURIComponent(date)}`);
    src.onmessage = (e) => setLines((prev) => [...prev, e.data]);
    src.addEventListener("done", () => { setFinalStatus("done"); src.close(); setTimeout(onDone, 400); });
    src.addEventListener("failed", () => { setFinalStatus("failed"); src.close(); });
    src.onerror = () => { src.close(); };
    return () => src.close();
  }, [open, date, onDone]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md fade-up"
         role="status" aria-live="polite" aria-label="Building today's digest">
      <div className="mb-6 text-center">
        <div className="mb-2 text-lg font-medium text-zinc-100">Building today's digest</div>
        <div className="text-xs text-zinc-400">arXiv fetch + AI tier ranking {"·"} a few seconds</div>
      </div>
      <ul className="glass-elevated w-[min(520px,90vw)] space-y-1 rounded-xl p-4 font-mono text-xs text-zinc-300">
        {lines.map((line, i) => <li key={i} className="fade-up">{line}</li>)}
        {finalStatus === null && (
          <li className="flex items-center gap-2 text-zinc-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            working...
          </li>
        )}
        {finalStatus === "failed" && <li className="text-rose-400">build failed {"—"} see backend logs</li>}
      </ul>
    </div>,
    document.body,
  );
}
