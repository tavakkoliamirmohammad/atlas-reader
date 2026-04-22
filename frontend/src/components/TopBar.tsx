import { useEffect, useState } from "react";
import { PanelToggles } from "./PanelToggles";
import { AiStatusPill } from "./AiStatusPill";
import { BackendPicker } from "./BackendPicker";
import { AppearanceMenu } from "./AppearanceMenu";
import { api } from "@/lib/api";

export function TopBar() {
  const [ai, setAi] = useState<boolean | null>(null);
  const [backends, setBackends] = useState<{ claude: boolean; codex: boolean } | null>(null);
  useEffect(() => {
    api.health()
      .then((h) => {
        setAi(h.ai);
        if (h.backends) setBackends(h.backends);
      })
      .catch(() => setAi(false));
  }, []);

  return (
    <div className="topbar-glass relative z-10 flex items-center gap-3 px-4 h-[52px]">
      {/* Brand — minimal editorial imprint. A serif "A" cap drawn in SVG as
          the mark (works as a favicon and scales crisply), paired with the
          wordmark in Instrument Serif Italic. Solid colors only — we had a
          gradient-on-gradient earlier that read as generic AI-template.
          The italic gives the wordmark character without needing
          decoration. */}
      <a
        href="/"
        aria-label="Atlas — home"
        className="inline-flex items-center gap-2 shrink-0 group h-7"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="w-[18px] h-[18px] block transition-transform duration-300 group-hover:rotate-[-4deg]"
          fill="none"
          stroke="var(--ac1)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Seriffed "A" cap — two diagonals, a crossbar, and two tiny
              serif feet. Stroke only; no fill, no tile. The serifs are
              what tie the mark to the Instrument Serif wordmark. */}
          <path d="M4 21 L12 3 L20 21" />
          <path d="M7.5 15 L16.5 15" />
          <path d="M3 21 L5 21 M19 21 L21 21" />
        </svg>
        <span className="brand-wordmark">Atlas</span>
      </a>

      <div aria-hidden className="flex-1" />

      {/* Primary task control */}
      <BackendPicker available={backends} />

      {/* Secondary controls — icon only */}
      <div className="flex items-center gap-1">
        <PanelToggles />
        <AppearanceMenu />
        <AiStatusPill ai={ai} />
      </div>
    </div>
  );
}
