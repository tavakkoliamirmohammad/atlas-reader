import { useEffect, useRef, useState } from "react";
import { Check, Copy, Lock } from "lucide-react";

const COMMAND = "claude login";
const COPIED_FLASH_MS = 1200;

export function ReaderOnlyCta() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(COMMAND);
    } catch {
      // Clipboard denied — still flash so the affordance feels responsive;
      // the visible text is already selectable as a fallback.
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_FLASH_MS);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <div
          className="w-[30px] h-[30px] rounded-lg flex items-center justify-center text-sm font-bold"
          style={{ background: "var(--user-grad)", color: "var(--user-ink)", boxShadow: "0 0 18px var(--ac1-mid)" }}
        >
          C
        </div>
        <div className="font-semibold text-[15px] text-slate-100">Reader-only mode</div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 gap-3 text-center">
        <div className="w-14 h-14 rounded-full bg-white/[0.04] border border-dashed border-white/15 flex items-center justify-center text-slate-500">
          <Lock size={22} />
        </div>
        <h3 className="text-[15px] text-slate-200 m-0">Claude isn't connected</h3>
        <p className="text-xs text-slate-400 m-0 leading-relaxed max-w-[260px]">
          The PDF viewer, daily digest, and search work normally. Connect Claude to enable summaries, ranking, and Q&amp;A.
        </p>
        <button
          type="button"
          onClick={copyCommand}
          aria-label={copied ? "Copied claude login" : "Copy claude login"}
          className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-[10px] bg-white/[0.04] border border-white/10 hover:border-[color:var(--ac1-mid)] hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <span className="text-[11px] text-slate-500">run</span>
          <span className="font-mono text-[12px] text-slate-200">{COMMAND}</span>
          {copied ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-[color:var(--ac1)]">
              <Check size={11} />
              Copied
            </span>
          ) : (
            <Copy size={11} className="text-slate-400" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}
