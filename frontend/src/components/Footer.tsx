import { useEffect, useState } from "react";
import { useUiStore } from "@/stores/ui-store";
import { u } from "@/lib/api";

type Health = { ai: boolean; backends?: { claude: boolean; codex: boolean } };

export function Footer() {
  const backend = useUiStore((s) => s.backend);
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    fetch(u("/api/health"))
      .then((r) => r.json())
      .then((b: Health) => setHealth(b))
      .catch(() => setHealth({ ai: false }));
  }, []);

  const ai = health?.ai ?? null;
  const selectedAvailable =
    health?.backends ? health.backends[backend] : ai;
  const label = backend === "codex" ? "Codex" : "Claude";

  return (
    <footer className="glass relative z-10 flex items-center justify-between px-4 py-1.5 text-[11px] text-zinc-500 border-x-0 border-b-0">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            selectedAvailable
              ? "bg-emerald-400 shadow-[0_0_6px_#34d399]"
              : "bg-zinc-500"
          }`}
          aria-hidden="true"
        />
        {ai === null ? (
          <span>checking...</span>
        ) : selectedAvailable ? (
          <span>{label}</span>
        ) : (
          <span>{label} not detected</span>
        )}
      </div>
      <div className="hidden gap-3 md:flex">
        <Hint k="?"  label="shortcuts" />
        <Hint k={"⌘K"} label="palette" />
        <Hint k="["  label="left" />
        <Hint k="]"  label="right" />
      </div>
    </footer>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded bg-white/5 px-1.5 py-px font-mono text-[10px] text-zinc-300">{k}</kbd>
      <span>{label}</span>
    </span>
  );
}
