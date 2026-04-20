import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { AuroraBackground } from "./components/AuroraBackground";
import { PaperList } from "./components/PaperList";
import { RightPanel } from "./components/RightPanel";
import { ReopenTab } from "./components/ReopenTab";
import { IndexRoute } from "./routes/IndexRoute";
import { ReaderRoute } from "./routes/ReaderRoute";
import { useUiStore } from "./stores/ui-store";
import { applyPalette, getPaletteById } from "./lib/theme";
import { useGlobalShortcuts } from "./lib/keyboard";

export default function App() {
  const leftCollapsed = useUiStore((s) => s.leftCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightCollapsed);
  const paletteId = useUiStore((s) => s.paletteId);

  useEffect(() => {
    const p = getPaletteById(paletteId);
    if (p) applyPalette(p);
  }, [paletteId]);

  useGlobalShortcuts();

  const leftW = leftCollapsed ? "0px" : "270px";
  const rightW = rightCollapsed ? "0px" : "320px";

  return (
    <div className="stage-shell">
      <AuroraBackground />
      <TopBar />
      <div
        className="relative z-[1] grid min-h-[calc(100vh-58px)] text-slate-200 transition-[grid-template-columns] duration-300"
        style={{ gridTemplateColumns: `${leftW} 1fr ${rightW}` }}
      >
        <aside className={["glass-panel relative border-r border-white/5 overflow-hidden transition-opacity",
                           leftCollapsed ? "opacity-0 pointer-events-none" : ""].join(" ")}>
          <PaperList />
        </aside>

        {leftCollapsed && <ReopenTab side="left" />}

        <main className="relative overflow-hidden">
          <Routes>
            <Route path="/" element={<IndexRoute />} />
            <Route path="/reader/:arxivId" element={<ReaderRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        {rightCollapsed && <ReopenTab side="right" />}

        <aside className={["glass-panel relative border-l border-white/5 overflow-hidden transition-opacity flex flex-col",
                           rightCollapsed ? "opacity-0 pointer-events-none" : ""].join(" ")}>
          <RightPanel />
        </aside>
      </div>
    </div>
  );
}
