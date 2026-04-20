import { Routes, Route, Navigate, useMatch } from "react-router-dom";
import { useEffect, useState } from "react";
import { TopBar } from "./components/TopBar";
import { AuroraBackground } from "./components/AuroraBackground";
import { PaperList } from "./components/PaperList";
import { RightPanel } from "./components/RightPanel";
import { RightPanelResizer } from "./components/RightPanelResizer";
import { ReopenTab } from "./components/ReopenTab";
import { IndexRoute } from "./routes/IndexRoute";
import { ReaderRoute } from "./routes/ReaderRoute";
import { useUiStore } from "./stores/ui-store";
import { applyPalette, getPaletteById } from "./lib/theme";
import { installKeyboard, useShortcut } from "./lib/keyboard";
import { installMotionAttribute } from "./lib/motion";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { CommandPalette } from "./components/CommandPalette";
import { SearchPalette } from "./components/SearchPalette";
import { Footer } from "./components/Footer";
import { BuildProgressOverlay } from "./components/BuildProgressOverlay";

export default function App() {
  const leftCollapsed = useUiStore((s) => s.leftCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightCollapsed);
  const paletteId = useUiStore((s) => s.paletteId);

  useEffect(() => {
    const p = getPaletteById(paletteId);
    if (p) applyPalette(p);
  }, [paletteId]);

  useEffect(() => {
    installKeyboard();
    installMotionAttribute();
  }, []);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const todayISO = new Date().toISOString().slice(0, 10);

  // On first load, if /api/digest is empty, kick off a build with progress overlay
  useEffect(() => {
    fetch("/api/digest").then((r) => r.json()).then((b) => {
      if ((b?.count ?? 0) === 0) {
        setBuildOpen(true);
        fetch("/api/digest?build=true").catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const readerMatch = useMatch("/reader/:arxivId");
  const onReaderRoute = !!readerMatch;

  useShortcut("[", () => useUiStore.getState().toggleLeft());
  useShortcut("]", () => useUiStore.getState().toggleRight());
  useShortcut("?", () => setShortcutsOpen((v) => !v));
  useShortcut("mod+k", () => setPaletteOpen((v) => !v));
  useShortcut("/", () => setSearchOpen((v) => !v));
  useShortcut(
    "s",
    () => {
      if (!onReaderRoute) return;
      useUiStore.getState().requestSummarize();
    },
    [onReaderRoute],
  );
  useShortcut("escape", () => {
    setShortcutsOpen(false);
    setPaletteOpen(false);
    setSearchOpen(false);
  });

  const leftW = leftCollapsed ? "0px" : "270px";
  // Right panel width is driven by --right-w (set by RightPanelResizer / persisted
  // in localStorage). When collapsed we fall back to 0.
  const rightW = rightCollapsed ? "0px" : "var(--right-w)";

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
          {!rightCollapsed && <RightPanelResizer />}
          <RightPanel />
        </aside>

        <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onSearch={() => {
            setPaletteOpen(false);
            setSearchOpen(true);
          }}
          onShowShortcuts={() => {
            setPaletteOpen(false);
            setShortcutsOpen(true);
          }}
        />
        <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
        <BuildProgressOverlay open={buildOpen} date={todayISO} onDone={() => setBuildOpen(false)} />
      </div>
      <Footer />
    </div>
  );
}
