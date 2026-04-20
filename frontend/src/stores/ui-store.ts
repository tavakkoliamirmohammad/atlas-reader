import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "light" | "sepia" | "dark";

export type CustomPalette = { c1: string; c2: string; ink: string };

export type ModelChoice = "opus" | "sonnet" | "haiku";

type UiState = {
  paletteId: string;
  customPalette: CustomPalette | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  readingMode: ReadingMode;
  model: ModelChoice;
  setPalette: (id: string) => void;
  setCustomPalette: (p: CustomPalette | null) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setReadingMode: (m: ReadingMode) => void;
  setModel: (m: ModelChoice) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      paletteId: "cyan-emerald",
      customPalette: null,
      leftCollapsed: false,
      rightCollapsed: false,
      readingMode: "light",
      model: "sonnet",
      setPalette: (id) => set({ paletteId: id }),
      setCustomPalette: (p) => set({ customPalette: p }),
      toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
      toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
      setReadingMode: (m) => set({ readingMode: m }),
      setModel: (m) => set({ model: m }),
    }),
    { name: "atlas-ui" },
  ),
);
