import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Backend, CodexModel, DigestRange, HighlightColor, ModelChoice,
} from "@/lib/api";

export type { Backend, CodexModel, DigestRange, ModelChoice };

export type ReadingMode = "light" | "sepia" | "dark";
export type AppMode = "dark" | "light";

export type CustomPalette = { c1: string; c2: string; ink: string };

/**
 * Visual / session preferences. Everything here is persisted to localStorage
 * EXCEPT `chipsCollapsed`, which intentionally resets every load so quick
 * actions reopen for discoverability.
 *
 * Ephemeral cross-component action dispatchers (summarize/ask/jumpToPage
 * request ids and pinnedQuote) live in `ui-actions-store` so the
 * `partialize` exclusion list here only needs to cover the one truly
 * session-only flag.
 */

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
  digestCategories: string[];
  setDigestCategories: (cats: string[]) => void;
  chipsCollapsed: boolean;
  toggleChipsCollapsed: () => void;
  setBackend: (b: Backend) => void;
  setCodexModel: (m: CodexModel) => void;
  setAppMode: (m: AppMode) => void;
  toggleAppMode: () => void;
  setPalette: (id: string) => void;
  setCustomPalette: (p: CustomPalette | null) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setReadingMode: (m: ReadingMode) => void;
  setModel: (m: ModelChoice) => void;
  setLastHighlightColor: (c: HighlightColor) => void;
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
      digestRange: 3,
      setDigestRange: (r) => set({ digestRange: r }),
      digestCategories: ["cs.PL", "cs.AR", "cs.DC", "cs.PF", "cs.LG"],
      setDigestCategories: (cats) =>
        set({ digestCategories: Array.from(new Set(cats)) }),
      chipsCollapsed: false,
      toggleChipsCollapsed: () =>
        set((s) => ({ chipsCollapsed: !s.chipsCollapsed })),
      setBackend: (b) => set({ backend: b }),
      setCodexModel: (m) => set({ codexModel: m }),
      setAppMode: (m) => set({ appMode: m, readingMode: m }),
      toggleAppMode: () =>
        set((s) => {
          const next: AppMode = s.appMode === "dark" ? "light" : "dark";
          return { appMode: next, readingMode: next };
        }),
      setPalette: (id) => set({ paletteId: id }),
      setCustomPalette: (p) => set({ customPalette: p }),
      toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
      toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
      setReadingMode: (m) => set({ readingMode: m }),
      setModel: (m) => set({ model: m }),
      setLastHighlightColor: (c) => set({ lastHighlightColor: c }),
      cycleReadingMode: () =>
        set((s) => {
          const i = READING_MODE_CYCLE.indexOf(s.readingMode);
          const next = READING_MODE_CYCLE[(i + 1) % READING_MODE_CYCLE.length];
          return { readingMode: next };
        }),
    }),
    {
      name: "atlas-ui",
      version: 3,
      storage: createJSONStorage(() => localStorage),
      // v2 dropped the `1d` digest range; v3 drops the `"all"` value
      // (which behaved identically to 30d under MAX_PER_CATEGORY=100).
      // Both migrations land users on a sensible window instead of
      // a gone-or-empty pill after deploy.
      migrate: (persisted: unknown, version) => {
        const p = persisted as Record<string, unknown> | null;
        if (!p) return p as unknown as UiState;
        if (version < 2 && p.digestRange === 1) p.digestRange = 7;
        if (version < 3 && p.digestRange === "all") p.digestRange = 30;
        return p as UiState;
      },
      // chipsCollapsed is the only intentionally non-persisted field — quick
      // actions reopen on every load for discoverability. Everything else in
      // the store is session-stable and persisted.
      partialize: (s) => {
        const { chipsCollapsed: _omit, ...rest } = s;
        void _omit;
        return rest;
      },
    },
  ),
);
