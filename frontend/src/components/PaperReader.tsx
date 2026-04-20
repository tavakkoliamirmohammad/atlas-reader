import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  api,
  createHighlight,
  deleteHighlight,
  fetchHighlights,
  type Highlight,
  type HighlightColor,
  type Paper,
  type SelectionRect,
} from "@/lib/api";
import { useUiStore } from "@/stores/ui-store";
import { PdfPage } from "./PdfPage";
import type { HighlightWithPosition, SelectionPayload } from "./PdfViewport";

const OVERLAY_COLORS: Record<HighlightColor, string> = {
  yellow: "rgba(250,204,21,0.35)",
  coral:  "rgba(251,113,133,0.35)",
  blue:   "rgba(96,165,250,0.35)",
};

type Props = { arxivId: string };

type HighlightsContextValue = {
  arxivId: string;
  items: Highlight[];
  onAdd: (input: {
    quote: string;
    color: HighlightColor;
    page?: number | null;
    rects?: SelectionRect[] | null;
  }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onJump: (page: number) => void;
};

const HighlightsContext = createContext<HighlightsContextValue | null>(null);

export function useHighlightsContext(): HighlightsContextValue | null {
  return useContext(HighlightsContext);
}

export function HighlightsProvider({
  value,
  children,
}: {
  value: HighlightsContextValue;
  children: ReactNode;
}) {
  return (
    <HighlightsContext.Provider value={value}>
      {children}
    </HighlightsContext.Provider>
  );
}

export function PaperReader({ arxivId }: Props) {
  const [, setPaper] = useState<Paper | null>(null);
  const mode = useUiStore((s) => s.readingMode);
  const defaultHighlightColor = useUiStore((s) => s.lastHighlightColor);
  const setLastHighlightColor = useUiStore((s) => s.setLastHighlightColor);
  const setPinnedQuote = useUiStore((s) => s.setPinnedQuote);
  const [items, setItems] = useState<Highlight[]>([]);
  const [selection, setSelection] = useState<SelectionPayload | null>(null);
  const jumpRef = useRef<((pageNumber: number) => void) | null>(null);

  useEffect(() => {
    api.paper(arxivId).then(setPaper).catch(() => setPaper(null));
  }, [arxivId]);

  useEffect(() => {
    let alive = true;
    fetchHighlights(arxivId)
      .then((rows) => { if (alive) setItems(rows); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [arxivId]);

  const onAdd = useCallback(
    async (input: {
      quote: string;
      color: HighlightColor;
      page?: number | null;
      rects?: SelectionRect[] | null;
    }) => {
      const id = await createHighlight(arxivId, input);
      setItems((prev) => [
        {
          id,
          arxiv_id: arxivId,
          quote: input.quote,
          color: input.color,
          page: input.page ?? null,
          note: null,
          rects: input.rects ?? null,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
    },
    [arxivId],
  );

  const onDelete = useCallback(async (id: number) => {
    let prev: Highlight[] | null = null;
    setItems((cur) => {
      prev = cur;
      return cur.filter((h) => h.id !== id);
    });
    try {
      await deleteHighlight(id);
    } catch {
      if (prev) setItems(prev);
    }
  }, []);

  const onJump = useCallback((page: number) => {
    jumpRef.current?.(page);
  }, []);

  const contextValue: HighlightsContextValue = useMemo(
    () => ({ arxivId, items, onAdd, onDelete, onJump }),
    [arxivId, items, onAdd, onDelete, onJump],
  );

  const overlayHighlights: HighlightWithPosition[] = useMemo(
    () =>
      items.flatMap((h) =>
        h.rects && h.page != null
          ? [{
              id: h.id,
              page: h.page,
              color: OVERLAY_COLORS[h.color],
              rects: h.rects,
            }]
          : [],
      ),
    [items],
  );

  const saveFromSelection = useCallback(
    async (color: HighlightColor) => {
      if (!selection) return;
      try {
        await onAdd({
          quote: selection.text,
          color,
          page: selection.page,
          rects: selection.rects,
        });
        setLastHighlightColor(color);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      } catch (err) {
        // Keep the selection + toolbar so the user can retry. Log for debugging.
        console.error("[Atlas] failed to save highlight:", err);
      }
    },
    [selection, onAdd, setLastHighlightColor],
  );

  const askFromSelection = useCallback(() => {
    if (!selection) return;
    setPinnedQuote({ text: selection.text, page: selection.page });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, setPinnedQuote]);

  return (
    <HighlightsProvider value={contextValue}>
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-hidden p-4">
          <PdfPage
            fileUrl={api.pdfUrl(arxivId)}
            mode={mode}
            arxivId={arxivId}
            highlights={overlayHighlights}
            selection={selection}
            onSelection={setSelection}
            jumpRef={jumpRef}
            onHighlightSave={saveFromSelection}
            onHighlightAsk={askFromSelection}
            defaultHighlightColor={defaultHighlightColor}
          />
        </div>
      </div>
    </HighlightsProvider>
  );
}
