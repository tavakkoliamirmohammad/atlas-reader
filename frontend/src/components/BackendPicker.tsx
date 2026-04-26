import type { Backend } from "@/lib/api";
import { useUiStore } from "@/stores/ui-store";

type Props = {
  available: { claude: boolean; codex: boolean } | null;
};

const OPTIONS: { value: Backend; label: string }[] = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
];

export function BackendPicker({ available }: Props) {
  const backend = useUiStore((s) => s.backend);
  const setBackend = useUiStore((s) => s.setBackend);

  return (
    <div
      role="radiogroup"
      aria-label="AI backend"
      className="inline-flex items-center rounded-full p-0.5 bg-white/[0.04] border border-white/5 text-xs"
    >
      {OPTIONS.map(({ value, label }) => {
        const active = backend === value;
        const enabled = available ? available[value] : true;
        const onClick = () => {
          if (enabled) setBackend(value);
        };
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!enabled}
            onClick={onClick}
            className={[
              "px-2.5 py-1 rounded-full transition-colors",
              active
                ? "bg-white/10 text-slate-100 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
                : "text-slate-400 hover:text-slate-200",
              !enabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
            ].join(" ")}
            title={
              enabled
                ? `Use ${label} for summarize / ask / ranking`
                : value === "codex"
                  ? "Codex unavailable — install the codex CLI and run it once to populate the model list"
                  : `${label} CLI not available on the host`
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
