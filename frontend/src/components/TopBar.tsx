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
      {/* Brand — gradient-stroked compass rose on a dark glass tile, paired
          with a Fraunces display serif wordmark. The serif reads as an
          "intellectual" / literary cue that matches the paper-reader
          product; gradient text fill keeps the brand palette consistent
          without painting the tile too loudly. */}
      <a
        href="/"
        aria-label="Atlas — home"
        className="inline-flex items-baseline gap-2.5 shrink-0 group h-7"
      >
        <span
          aria-hidden
          className="relative inline-flex items-center justify-center w-7 h-7 rounded-[8px] self-center transition-transform duration-200 group-hover:scale-[1.06] group-hover:rotate-[6deg]"
          style={{
            background: "var(--brand-icon-tile-bg)",
            boxShadow:
              "inset 0 0 0 1px var(--ac1-mid), 0 4px 14px -6px var(--ac1-mid), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            className="w-4 h-4 block"
            fill="none"
            stroke="url(#atlas-brand-g)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <defs>
              <linearGradient id="atlas-brand-g" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="var(--ac1)" />
                <stop offset="100%" stopColor="var(--ac2)" />
              </linearGradient>
            </defs>
            {/* Diamond compass body with faint fill for volume */}
            <path d="M12 3 L14.8 12 L12 21 L9.2 12 Z" fill="url(#atlas-brand-g)" fillOpacity="0.14" />
            {/* Cardinal cross */}
            <path d="M12 3 V21 M3 12 H21" />
            {/* Center bead */}
            <circle cx="12" cy="12" r="1.3" fill="var(--ac1)" stroke="none" />
          </svg>
        </span>
        <span
          className="brand-wordmark"
          style={{
            background: "var(--user-grad)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
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
