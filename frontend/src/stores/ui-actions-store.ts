import { create } from "zustand";

/**
 * Ephemeral cross-component action dispatchers — none of this state survives
 * a page reload, so it lives in a separate store from `ui-store` (which
 * persists into localStorage).
 *
 * The pattern: action methods bump an `id` counter; consumers fire on each
 * new id via `useEffect(..., [id])`. A `null`-checking subscriber treats the
 * initial `null` value as "no pending action" without an explicit guard.
 *
 * Moved out of `ui-store` because adding a new dispatcher to that store
 * required also remembering to exclude it from the `partialize` list — a
 * correctness trap that quietly serialised one-off action state into
 * localStorage and confused the persistence migration logic. Here there's
 * no `persist` middleware to forget about.
 */

export type AskRequest = { id: number; prompt: string; displayLabel?: string };
export type JumpToPageRequest = { id: number; page: number };
export type PinnedQuote = { text: string; page: number };

type State = {
  summarizeRequestId: number;
  askRequest: AskRequest | null;
  jumpToPageRequest: JumpToPageRequest | null;
  pinnedQuote: PinnedQuote | null;
  requestSummarize: () => void;
  requestAsk: (prompt: string, displayLabel?: string) => void;
  requestJumpToPage: (page: number) => void;
  setPinnedQuote: (q: PinnedQuote) => void;
  clearPinnedQuote: () => void;
};

export const useUiActionsStore = create<State>()((set) => ({
  summarizeRequestId: 0,
  askRequest: null,
  jumpToPageRequest: null,
  pinnedQuote: null,
  requestSummarize: () =>
    set((s) => ({ summarizeRequestId: s.summarizeRequestId + 1 })),
  requestAsk: (prompt, displayLabel) =>
    set((s) => ({
      askRequest: { id: (s.askRequest?.id ?? 0) + 1, prompt, displayLabel },
    })),
  requestJumpToPage: (page) =>
    set((s) => ({
      jumpToPageRequest: { id: (s.jumpToPageRequest?.id ?? 0) + 1, page },
    })),
  setPinnedQuote: (q) => set({ pinnedQuote: q }),
  clearPinnedQuote: () => set({ pinnedQuote: null }),
}));
