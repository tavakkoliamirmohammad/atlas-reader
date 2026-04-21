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
      {/* Brand — icon + wordmark share a single flex row so items-center
          does the optical centering; no translate-y hacks. Font is set to a
          line-height that matches the tile so the text box doesn't add
          phantom top/bottom padding. */}
      <a
        href="/"
        aria-label="Atlas — home"
        className="inline-flex items-center gap-2 shrink-0 group h-7"
      >
        <span
          aria-hidden
          className="inline-flex items-center justify-center w-7 h-7 rounded-[9px] overflow-hidden transition-transform group-hover:scale-[1.04]"
          style={{
            background: "var(--user-grad)",
            boxShadow: "0 3px 10px -3px var(--ac1-mid), inset 0 0 0 1px rgba(255,255,255,0.08)",
          }}
        >
          <svg viewBox="0 0 24 24" className="w-[15px] h-[15px] block" fill="var(--user-ink)">
            <path d="M12 3 L13.1 9.9 L20 11 L13.1 12.1 L12 21 L10.9 12.1 L4 11 L10.9 9.9 Z" />
            <circle cx="12" cy="11" r="1.25" fill="var(--ac1)" />
          </svg>
        </span>
        <span
          className="text-[15px] font-semibold tracking-tight text-slate-100"
          style={{ lineHeight: "28px" }}
        >
          Atlas
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
