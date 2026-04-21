import { QUICK_PROMPTS } from "@/lib/quick-prompts";

type Props = {
  onSummarize: () => void;
  /** `displayLabel` is what we render as the user's chat bubble; the full
   *  `prompt` is what gets sent to the model. */
  onQuickAsk: (prompt: string, displayLabel?: string) => void;
  disabled?: boolean;
  /**
   * When non-null, the Summarize chip swaps its label to a live
   * "Summarizing 4s…" indicator. Used while a streaming summary is in flight.
   */
  summarizeElapsedMs?: number | null;
};

function formatElapsed(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

export function QuickActionChips({
  onSummarize,
  onQuickAsk,
  disabled,
  summarizeElapsedMs,
}: Props) {
  const showElapsed =
    typeof summarizeElapsedMs === "number" && summarizeElapsedMs >= 2000;
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={onSummarize}
        disabled={disabled}
        aria-label="Generate deep summary"
        aria-live="polite"
        className="px-3 py-1.5 rounded-full text-[11px] font-semibold cursor-pointer disabled:opacity-50 transition-all hover:translate-y-[-1px] shimmer"
        style={{
          background: "var(--user-grad)",
          color: "var(--user-ink)",
          boxShadow: "0 0 0 1px var(--ac1-mid), 0 6px 18px -4px var(--ac1-strong)",
        }}
      >
        {showElapsed
          ? `⚡ Summarizing ${formatElapsed(summarizeElapsedMs as number)}…`
          : "⚡ Summarize"}
      </button>
      {QUICK_PROMPTS.map((q) => (
        <button
          key={q.label}
          onClick={() => onQuickAsk(q.prompt, q.displayLabel)}
          disabled={disabled}
          className="px-3 py-1.5 rounded-full text-[11px] cursor-pointer disabled:opacity-50 bg-white/[0.04] border border-white/5 text-slate-300 hover:bg-white/[0.08] hover:text-white hover:border-[color:var(--ac1-mid)] transition-colors"
        >
          <span aria-hidden className="mr-1">{q.icon}</span>{q.label}
        </button>
      ))}
    </div>
  );
}
