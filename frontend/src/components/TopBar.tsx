import { useEffect, useState } from "react";
import { ThemePicker } from "./ThemePicker";
import { PanelToggles } from "./PanelToggles";
import { AiStatusPill } from "./AiStatusPill";
import { Greeting } from "./Greeting";
import { Streak } from "./Streak";
import { api } from "@/lib/api";

export function TopBar() {
  const [ai, setAi] = useState<boolean | null>(null);
  useEffect(() => {
    api.health().then((h) => setAi(h.ai)).catch(() => setAi(false));
  }, []);

  return (
    <div className="relative z-10 flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-white/5 bg-[rgba(8,8,13,0.6)] backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <div
          className="w-[30px] h-[30px] rounded-[9px] flex items-center justify-center text-[14px] font-extrabold"
          style={{ background: "var(--user-grad)", color: "var(--user-ink)", boxShadow: "0 0 24px var(--ac1-mid)" }}
        >
          A
        </div>
        <div className="text-sm font-semibold text-slate-100">Atlas</div>
        <Greeting />
      </div>
      <div className="flex-1" />
      <ThemePicker />
      <PanelToggles />
      <AiStatusPill ai={ai} />
      <Streak />
    </div>
  );
}
