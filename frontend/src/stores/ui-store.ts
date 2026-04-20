import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "light" | "sepia" | "dark";

type UiState = {
  paletteId: string;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  readingMode: ReadingMode;
  setPalette: (id: string) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setReadingMode: (m: ReadingMode) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      paletteId: "cyan-emerald",
      leftCollapsed: false,
      rightCollapsed: false,
      readingMode: "light",
      setPalette: (id) => set({ paletteId: id }),
      toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
      toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
      setReadingMode: (m) => set({ readingMode: m }),
    }),
    { name: "atlas-ui" },
  ),
);
