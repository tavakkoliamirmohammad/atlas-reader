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
    <div className="relative z-10 flex items-center gap-3 px-4 h-[52px] border-b border-white/5 bg-[rgba(8,8,13,0.6)] backdrop-blur-xl">
      {/* Brand */}
      <a href="/" aria-label="Atlas — home" className="flex items-center gap-2 shrink-0 group">
        <span
          className="relative w-8 h-8 rounded-[10px] flex items-center justify-center overflow-hidden transition-transform group-hover:scale-[1.04]"
          style={{
            background: "var(--user-grad)",
            boxShadow: "0 4px 14px -4px var(--ac1-mid), inset 0 0 0 1px rgba(255,255,255,0.08)",
          }}
        >
          {/* Minimalist sparkle/compass mark — reads as "discover" without
              leaning on a text glyph. Ink color tracks the active palette. */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className="w-[18px] h-[18px]"
            fill="var(--user-ink)"
          >
            <path d="M12 2.8 L13.1 9.6 L19.9 10.9 L13.6 12.9 L12 21.2 L10.4 12.9 L4.1 10.9 L10.9 9.6 Z" />
            <circle cx="12" cy="11.5" r="1.4" fill="var(--ac1)" />
          </svg>
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-slate-100">
          atlas
        </span>
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
