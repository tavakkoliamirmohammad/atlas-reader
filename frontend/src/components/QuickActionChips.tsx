import { useEffect, useRef, useState } from "react";
import { Headphones } from "lucide-react";
import { QUICK_PROMPTS } from "@/lib/quick-prompts";

type Length = "short" | "medium" | "long";

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
  /** When provided, renders the "Listen" chip. Omit to hide the chip entirely. */
  onListen?: (length: Length) => void;
  /** When set, the Listen chip is disabled and this message is shown as a tooltip. */
  listenDisabledReason?: string;
};

function formatElapsed(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

const LENGTH_OPTIONS: { value: Length; label: string; desc: string }[] = [
  { value: "short",  label: "Short",  desc: "~3 min" },
  { value: "medium", label: "Medium", desc: "~7 min" },
  { value: "long",   label: "Long",   desc: "~15 min" },
];

export function QuickActionChips({
  onSummarize,
  onQuickAsk,
  disabled,
  summarizeElapsedMs,
  onListen,
  listenDisabledReason,
}: Props) {
  const showElapsed =
    typeof summarizeElapsedMs === "number" && summarizeElapsedMs >= 2000;

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  function handleLengthClick(length: Length) {
    setPickerOpen(false);
    onListen?.(length);
  }

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
      {onListen !== undefined && (
        <div ref={pickerRef} className="relative">
          <button
            onClick={() => {
              if (!listenDisabledReason && !disabled) setPickerOpen((v) => !v);
            }}
            disabled={disabled || !!listenDisabledReason}
            title={listenDisabledReason}
            aria-label="Listen as podcast"
            aria-expanded={pickerOpen}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] cursor-pointer disabled:opacity-50 bg-white/[0.04] border border-white/5 text-slate-300 hover:bg-white/[0.08] hover:text-white hover:border-[color:var(--ac1-mid)] transition-colors disabled:cursor-not-allowed"
          >
            <Headphones size={11} aria-hidden />
            Listen
          </button>
          {pickerOpen && (
            <div
              className="absolute bottom-full right-0 mb-2 w-44 rounded-xl backdrop-blur-md shadow-2xl z-30 overflow-hidden"
              role="menu"
              aria-label="Podcast length"
              style={{
                background: "var(--surface-overlay)",
                border: "1px solid var(--surface-overlay-border)",
                color: "var(--surface-overlay-text)",
              }}
            >
              {LENGTH_OPTIONS.map(({ value, label, desc }) => (
                <button
                  key={value}
                  type="button"
                  role="menuitem"
                  onClick={() => handleLengthClick(value)}
                  className="w-full flex items-center justify-between px-3 py-2 text-left text-[12px] hover:bg-white/5 transition-colors cursor-pointer"
                >
                  <span>{label}</span>
                  <span className="text-[10px] text-slate-400">{desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
