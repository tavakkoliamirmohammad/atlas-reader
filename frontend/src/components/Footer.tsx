import { useEffect, useState } from "react";

export function Footer() {
  const [ai, setAi] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((b) => setAi(Boolean(b.ai))).catch(() => setAi(false));
  }, []);

  return (
    <footer className="flex items-center justify-between border-t border-white/5 bg-black/30 px-4 py-1.5 text-[11px] text-zinc-500 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${ai ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-zinc-500"}`}
          aria-hidden="true"
        />
        <span>
          {ai === null ? "checking..." :
           ai ? "connected to Claude (subscription) \u00b7 no API charges" :
                "Claude CLI not detected \u00b7 reader-only mode"}
        </span>
      </div>
      <div className="hidden gap-3 md:flex">
        <Hint k="?"  label="shortcuts" />
        <Hint k={"\u2318K"} label="palette" />
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
