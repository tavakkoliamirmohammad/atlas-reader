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
      <div className="flex items-center gap-2 shrink-0">
        <div
          className="w-[30px] h-[30px] rounded-[9px] flex items-center justify-center text-[14px] font-extrabold"
          style={{ background: "var(--user-grad)", color: "var(--user-ink)", boxShadow: "0 0 24px var(--ac1-mid)" }}
        >
          A
        </div>
        <div className="text-sm font-semibold text-slate-100">Atlas</div>
      </div>

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
