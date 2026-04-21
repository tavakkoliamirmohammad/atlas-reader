import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Backend, CodexModel, DigestRange, HighlightColor, ModelChoice,
} from "@/lib/api";

export type { Backend, CodexModel, DigestRange, ModelChoice };

export type ReadingMode = "light" | "sepia" | "dark";
export type AppMode = "dark" | "light";

export type CustomPalette = { c1: string; c2: string; ink: string };

export type AskRequest = { id: number; prompt: string; displayLabel?: string };

type UiState = {
  paletteId: string;
  customPalette: CustomPalette | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  readingMode: ReadingMode;
  appMode: AppMode;
  model: ModelChoice;
  codexModel: CodexModel;
  backend: Backend;
  lastHighlightColor: HighlightColor;
  digestRange: DigestRange;
  setDigestRange: (r: DigestRange) => void;
  setBackend: (b: Backend) => void;
  setCodexModel: (m: CodexModel) => void;
  setAppMode: (m: AppMode) => void;
  toggleAppMode: () => void;
  // Ephemeral action dispatchers — NOT persisted. The action-id counters let
  // subscribers fire on each increment via a `useEffect(..., [id])`.
  summarizeRequestId: number;
  askRequest: AskRequest | null;
  pinnedQuote: { text: string; page: number } | null;
  setPinnedQuote: (q: { text: string; page: number }) => void;
  clearPinnedQuote: () => void;
  setPalette: (id: string) => void;
  setCustomPalette: (p: CustomPalette | null) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setReadingMode: (m: ReadingMode) => void;
  setModel: (m: ModelChoice) => void;
  setLastHighlightColor: (c: HighlightColor) => void;
  requestSummarize: () => void;
  requestAsk: (prompt: string, displayLabel?: string) => void;
  cycleReadingMode: () => void;
};

const READING_MODE_CYCLE: ReadingMode[] = ["light", "sepia", "dark"];

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      paletteId: "cyan-emerald",
      customPalette: null,
      leftCollapsed: false,
      rightCollapsed: false,
      readingMode: "light",
      appMode: "dark",
      model: "sonnet",
      codexModel: "gpt-5.4",
      backend: "codex",
      lastHighlightColor: "yellow",
      digestRange: 7,
      setDigestRange: (r) => set({ digestRange: r }),
      setBackend: (b) => set({ backend: b }),
      setCodexModel: (m) => set({ codexModel: m }),
      setAppMode: (m) => set({ appMode: m, readingMode: m }),
      toggleAppMode: () =>
        set((s) => {
          const next: AppMode = s.appMode === "dark" ? "light" : "dark";
          return { appMode: next, readingMode: next };
        }),
      summarizeRequestId: 0,
      askRequest: null,
      pinnedQuote: null,
      setPinnedQuote: (q) => set({ pinnedQuote: q }),
      clearPinnedQuote: () => set({ pinnedQuote: null }),
      setPalette: (id) => set({ paletteId: id }),
      setCustomPalette: (p) => set({ customPalette: p }),
      toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
      toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
      setReadingMode: (m) => set({ readingMode: m }),
      setModel: (m) => set({ model: m }),
      setLastHighlightColor: (c) => set({ lastHighlightColor: c }),
      requestSummarize: () => set((s) => ({ summarizeRequestId: s.summarizeRequestId + 1 })),
      requestAsk: (prompt, displayLabel) =>
        set((s) => ({
          askRequest: { id: (s.askRequest?.id ?? 0) + 1, prompt, displayLabel },
        })),
      cycleReadingMode: () =>
        set((s) => {
          const i = READING_MODE_CYCLE.indexOf(s.readingMode);
          const next = READING_MODE_CYCLE[(i + 1) % READING_MODE_CYCLE.length];
          return { readingMode: next };
        }),
    }),
    {
      name: "atlas-ui",
      storage: createJSONStorage(() => localStorage),
      // Only persist visual preferences — action-dispatcher fields are ephemeral.
      partialize: (s) => ({
        paletteId: s.paletteId,
        customPalette: s.customPalette,
        leftCollapsed: s.leftCollapsed,
        rightCollapsed: s.rightCollapsed,
        readingMode: s.readingMode,
        appMode: s.appMode,
        model: s.model,
        codexModel: s.codexModel,
        backend: s.backend,
        lastHighlightColor: s.lastHighlightColor,
        digestRange: s.digestRange,
      }),
    },
  ),
);
