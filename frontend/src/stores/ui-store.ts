import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HighlightColor, ModelChoice } from "@/lib/api";

export type { ModelChoice };

export type ReadingMode = "light" | "sepia" | "dark";

export type CustomPalette = { c1: string; c2: string; ink: string };

export type AskRequest = { id: number; prompt: string };

type UiState = {
  paletteId: string;
  customPalette: CustomPalette | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  readingMode: ReadingMode;
  model: ModelChoice;
  lastHighlightColor: HighlightColor;
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
  requestAsk: (prompt: string) => void;
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
      model: "sonnet",
      lastHighlightColor: "yellow",
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
      requestAsk: (prompt) =>
        set((s) => ({
          askRequest: { id: (s.askRequest?.id ?? 0) + 1, prompt },
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
        model: s.model,
        lastHighlightColor: s.lastHighlightColor,
      }),
    },
  ),
);
