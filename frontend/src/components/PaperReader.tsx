import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  const [items, setItems] = useState<Highlight[]>([]);
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
    setItems((cur) => {
      const prev = cur;
      // optimistic remove; restore on failure via catch below
      (async () => {
        try {
          await deleteHighlight(id);
        } catch {
          setItems(prev);
        }
      })();
      return cur.filter((h) => h.id !== id);
    });
  }, []);

  const onJump = useCallback((page: number) => {
    jumpRef.current?.(page);
  }, []);

  const contextValue: HighlightsContextValue = {
    arxivId,
    items,
    onAdd,
    onDelete,
    onJump,
  };

  return (
    <HighlightsProvider value={contextValue}>
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-hidden p-4">
          <PdfPage
            fileUrl={api.pdfUrl(arxivId)}
            mode={mode}
            arxivId={arxivId}
          />
        </div>
      </div>
    </HighlightsProvider>
  );
}
