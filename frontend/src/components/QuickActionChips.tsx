import { QUICK_PROMPTS } from "@/lib/quick-prompts";

type Props = {
  onSummarize: () => void;
  onQuickAsk: (prompt: string) => void;
  disabled?: boolean;
};

export function QuickActionChips({ onSummarize, onQuickAsk, disabled }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={onSummarize}
        disabled={disabled}
        aria-label="Generate deep summary"
        className="px-3 py-1.5 rounded-full text-[11px] font-semibold cursor-pointer disabled:opacity-50 transition-all hover:translate-y-[-1px] shimmer"
        style={{
          background: "var(--user-grad)",
          color: "var(--user-ink)",
          boxShadow: "0 0 0 1px var(--ac1-mid), 0 6px 18px -4px var(--ac1-strong)",
        }}
      >
        ⚡ Summarize
      </button>
      {QUICK_PROMPTS.map((q) => (
        <button
          key={q.label}
          onClick={() => onQuickAsk(q.prompt)}
          disabled={disabled}
          className="px-3 py-1.5 rounded-full text-[11px] cursor-pointer disabled:opacity-50 bg-white/[0.04] border border-white/5 text-slate-300 hover:bg-white/[0.08] hover:text-white hover:border-[color:var(--ac1-mid)] transition-colors"
        >
          <span aria-hidden className="mr-1">{q.icon}</span>{q.label}
        </button>
      ))}
    </div>
  );
}
