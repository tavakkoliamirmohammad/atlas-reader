type Props = {
  onSummarize: () => void;
  onQuickAsk: (prompt: string) => void;
  disabled?: boolean;
};

const QUICK = [
  { label: "Key contributions",     prompt: "What are the key contributions of this paper, in 3-5 bullet points?", icon: "★" },
  { label: "Compare to prior work", prompt: "How does this paper compare to closely related prior work? Cite the papers it positions against.", icon: "≈" },
  { label: "Open questions",        prompt: "What are the most interesting open questions or future-work directions this paper raises?", icon: "?" },
  { label: "Reproduce setup",       prompt: "Walk me through the exact setup needed to reproduce the main result: hardware, dataset, baselines, command lines if available.", icon: "⚙" },
];

export function QuickActionChips({ onSummarize, onQuickAsk, disabled }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={onSummarize}
        disabled={disabled}
        aria-label="Generate deep summary"
        className="px-3 py-1.5 rounded-full text-[11px] font-semibold cursor-pointer disabled:opacity-50 transition-all hover:translate-y-[-1px]"
        style={{
          background: "var(--user-grad)",
          color: "var(--user-ink)",
          boxShadow: "0 0 0 1px var(--ac1-mid), 0 6px 18px -4px var(--ac1-strong)",
        }}
      >
        ⚡ Summarize
      </button>
      {QUICK.map((q) => (
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
