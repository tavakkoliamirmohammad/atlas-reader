import { Lock } from "lucide-react";

export function ReaderOnlyCta() {
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
          className="mt-2 px-4 py-2 rounded-[10px] text-xs font-semibold cursor-pointer"
          style={{ background: "var(--user-grad)", color: "var(--user-ink)", boxShadow: "0 0 18px var(--ac1-mid)" }}
        >
          Connect Claude
        </button>
        <div className="text-[11px] text-slate-500">
          or run <span className="font-mono text-slate-400">claude login</span> in terminal
        </div>
      </div>
    </div>
  );
}
