import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import type { ReadingMode } from "@/stores/ui-store";
import type { RailSection } from "./ReadingProgressRail";

// Wire up the worker exactly once. Vite's `new URL(..., import.meta.url)`
// pattern emits the worker as a separate chunk and preserves its module
// dependencies — required because pdfjs ships the worker as ESM in v5+.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const MODE_FILTER: Record<ReadingMode, string> = {
  light: "none",
  sepia: "sepia(0.5) hue-rotate(-12deg) saturate(1.1) brightness(0.97)",
  dark: "invert(0.92) hue-rotate(180deg)",
};

const PAGE_BG: Record<ReadingMode, string> = {
  light: "#ffffff",
  sepia: "#f4ead4",
  dark: "#1a1c22",
};

const GAP = 12; // vertical gap between pages, px
const VIEWPORTS_AHEAD = 2; // render this many viewports of pages above + below visible area
const RENDER_LRU_LIMIT = 12;

type Props = {
  fileUrl: string;
  mode: ReadingMode;
  /** Fires whenever scroll position / current page changes. */
  onProgress?: (p: {
    current: number;
    total: number;
    scrollRatio: number;
  }) => void;
  /** Fires once after the outline is loaded. */
  onSections?: (sections: RailSection[]) => void;
  /** Imperative jump-to-page handle. */
  jumpRef?: React.MutableRefObject<((pageNumber: number) => void) | null>;
  /** Imperative handle so the parent can attach mouseenter on the scroll container. */
  scrollContainerRef?: React.MutableRefObject<HTMLDivElement | null>;
};

type PageMeta = {
  pageNumber: number; // 1-based
  width: number; // CSS px at fit-to-width scale
  height: number; // CSS px at fit-to-width scale
  scale: number; // pdfjs scale used to derive width/height
  offsetTop: number; // CSS px from container top
};

export function PdfViewport({
  fileUrl,
  mode,
  onProgress,
  onSections,
  jumpRef,
  scrollContainerRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const renderTasksRef = useRef<Map<number, RenderTask>>(new Map());
  const renderedOrderRef = useRef<number[]>([]); // LRU of rendered page numbers
  const renderedSetRef = useRef<Set<number>>(new Set());

  // The loaded PDF document lives in state so layout effects react when it
  // changes; we also keep a stable pointer for cleanup on unmount.
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);

  const [pages, setPages] = useState<PageMeta[]>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [scrollRatio, setScrollRatio] = useState(0);

  // Expose the scroll container ref to the parent (for mouseenter listener).
  useEffect(() => {
    if (scrollContainerRef) {
      scrollContainerRef.current = containerRef.current;
    }
  }, [scrollContainerRef]);

  // Track container width so we re-layout pages on resize.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const updateWidth = () => {
      // Subtract a little for the side padding so canvases don't bleed into
      // the rounded corners of the inner viewport.
      const padding = 24;
      setContainerWidth(Math.max(0, node.clientWidth - padding));
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Load the PDF document.
  useEffect(() => {
    let cancelled = false;
    // Resetting state here is the React-idiomatic way to handle a switch to a
    // new source URL — it's effectively "synchronize state to an external
    // resource". The lint rule flags this as a cascading render but we
    // _need_ the synchronous reset so stale pages/canvases don't flash.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    setPages([]);
    setCurrentPage(1);
    /* eslint-enable react-hooks/set-state-in-effect */
    renderedOrderRef.current = [];
    renderedSetRef.current = new Set();
    renderTasksRef.current.forEach((t) => t.cancel());
    renderTasksRef.current.clear();
    pageRefs.current.clear();

    const loadingTask = pdfjsLib.getDocument({ url: fileUrl });
    loadingTask.promise
      .then(async (doc) => {
        if (cancelled) {
          doc.destroy();
          return;
        }
        pdfDocRef.current?.destroy();
        pdfDocRef.current = doc;
        setPdfDoc(doc);

        // Read the outline (best-effort) and resolve destinations to page indexes.
        try {
          const outline = await doc.getOutline();
          if (cancelled) return;
          const sections = await flattenOutline(doc, outline);
          onSections?.(sections.slice(0, 60));
        } catch {
          onSections?.([]);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load PDF");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
    // We intentionally don't depend on onSections — only refetch when fileUrl changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl]);

  // Compute page metadata (dimensions, offsets) whenever the document or
  // container width changes. We stack pages vertically with `GAP` between.
  useEffect(() => {
    const doc = pdfDoc;
    if (!doc || containerWidth <= 0) return;
    let cancelled = false;

    const compute = async () => {
      const metas: PageMeta[] = [];
      let offset = 0;
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (cancelled) {
          page.cleanup();
          return;
        }
        // pdfjs viewport at scale=1 gives PDF pt; we want fit-to-width.
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = containerWidth / baseViewport.width;
        const width = containerWidth;
        const height = baseViewport.height * scale;
        metas.push({
          pageNumber: i,
          width,
          height,
          scale,
          offsetTop: offset,
        });
        offset += height + GAP;
        page.cleanup();
      }
      if (cancelled) return;
      setPages(metas);
      setLoading(false);
    };

    compute();
    return () => {
      cancelled = true;
    };
  }, [containerWidth, pdfDoc]);

  // Track scroll for both the progress callback and to decide which pages to render.
  const updateProgress = useCallback(() => {
    const node = containerRef.current;
    if (!node || pages.length === 0) return;
    const scrollTop = node.scrollTop;
    const scrollMax = Math.max(1, node.scrollHeight - node.clientHeight);
    const ratio = Math.max(0, Math.min(1, scrollTop / scrollMax));
    setScrollRatio(ratio);

    // Find the page whose midpoint is most visible — that's the "current" page.
    const viewportCenter = scrollTop + node.clientHeight / 2;
    let cur = 1;
    for (const p of pages) {
      if (p.offsetTop + p.height / 2 <= viewportCenter) cur = p.pageNumber;
      else break;
    }
    setCurrentPage(cur);
  }, [pages]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    updateProgress();
    node.addEventListener("scroll", updateProgress, { passive: true });
    return () => node.removeEventListener("scroll", updateProgress);
  }, [updateProgress]);

  useEffect(() => {
    if (pages.length === 0) return;
    onProgress?.({
      current: currentPage,
      total: pages.length,
      scrollRatio,
    });
  }, [currentPage, pages.length, scrollRatio, onProgress]);

  // Imperative jump-to-page.
  useEffect(() => {
    if (!jumpRef) return;
    jumpRef.current = (pageNumber: number) => {
      const meta = pages.find((p) => p.pageNumber === pageNumber);
      const node = containerRef.current;
      if (!meta || !node) return;
      node.scrollTo({ top: meta.offsetTop - 8, behavior: "smooth" });
    };
    return () => {
      if (jumpRef) jumpRef.current = null;
    };
  }, [jumpRef, pages]);

  // Render visible pages (and a margin around them).
  const renderPage = useCallback(
    async (pageNumber: number) => {
      const doc = pdfDoc;
      const meta = pages.find((p) => p.pageNumber === pageNumber);
      const wrap = pageRefs.current.get(pageNumber);
      if (!doc || !meta || !wrap) return;
      if (renderedSetRef.current.has(pageNumber)) {
        // Bump LRU.
        const order = renderedOrderRef.current.filter((n) => n !== pageNumber);
        order.push(pageNumber);
        renderedOrderRef.current = order;
        return;
      }
      // Cancel any in-flight task for this page.
      renderTasksRef.current.get(pageNumber)?.cancel();
      renderTasksRef.current.delete(pageNumber);

      let page: PDFPageProxy | null = null;
      try {
        page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: meta.scale });
        const dpr = window.devicePixelRatio || 1;

        // Find or create the canvas.
        let canvas = wrap.querySelector<HTMLCanvasElement>("canvas.pdf-canvas");
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.className = "pdf-canvas";
          canvas.style.position = "absolute";
          canvas.style.inset = "0";
          canvas.style.display = "block";
          wrap.appendChild(canvas);
        }
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${meta.width}px`;
        canvas.style.height = `${meta.height}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const transform: [number, number, number, number, number, number] | undefined =
          dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;

        const task = page.render({
          canvasContext: ctx,
          viewport,
          transform,
          background: PAGE_BG[mode],
        } as Parameters<PDFPageProxy["render"]>[0]);
        renderTasksRef.current.set(pageNumber, task);
        await task.promise;
        renderTasksRef.current.delete(pageNumber);

        // Mark rendered + bump LRU.
        renderedSetRef.current.add(pageNumber);
        const order = renderedOrderRef.current.filter((n) => n !== pageNumber);
        order.push(pageNumber);
        renderedOrderRef.current = order;

        // Evict oldest if over the LRU limit.
        while (renderedOrderRef.current.length > RENDER_LRU_LIMIT) {
          const evict = renderedOrderRef.current.shift();
          if (evict == null || evict === pageNumber) continue;
          renderedSetRef.current.delete(evict);
          const evictWrap = pageRefs.current.get(evict);
          if (evictWrap) {
            // Drop the canvas to free GPU/VRAM; placeholder slot remains so
            // the scroll height is stable.
            evictWrap.querySelector("canvas.pdf-canvas")?.remove();
          }
        }
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name;
        if (name === "RenderingCancelledException") return;
        // Otherwise swallow — the slot will just stay as a placeholder.
      } finally {
        page?.cleanup();
      }
    },
    [pdfDoc, pages, mode],
  );

  // Decide which pages to render based on scroll position.
  const updateVisibleRange = useCallback(() => {
    const node = containerRef.current;
    if (!node || pages.length === 0) return;
    const scrollTop = node.scrollTop;
    const viewH = node.clientHeight;
    const top = scrollTop - viewH * VIEWPORTS_AHEAD;
    const bottom = scrollTop + viewH * (1 + VIEWPORTS_AHEAD);
    for (const p of pages) {
      const pageTop = p.offsetTop;
      const pageBottom = p.offsetTop + p.height;
      if (pageBottom >= top && pageTop <= bottom) {
        renderPage(p.pageNumber);
      }
    }
  }, [pages, renderPage]);

  useEffect(() => {
    if (pages.length === 0) return;
    updateVisibleRange();
    const node = containerRef.current;
    if (!node) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        updateVisibleRange();
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [pages, updateVisibleRange]);

  // Re-render rendered pages when the reading mode changes — the canvas bg
  // hint differs per mode; the CSS filter alone handles the bulk of it but
  // a re-paint with the matching background color avoids halos at edges.
  useEffect(() => {
    if (pages.length === 0) return;
    const toRerender = Array.from(renderedSetRef.current);
    renderedSetRef.current.clear();
    renderedOrderRef.current = [];
    for (const p of toRerender) {
      pageRefs.current.get(p)?.querySelector("canvas.pdf-canvas")?.remove();
    }
    for (const p of toRerender) renderPage(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Cleanup on unmount. Capture the ref values up-front so the cleanup
  // function operates on the same instances that exist now.
  useEffect(() => {
    const tasks = renderTasksRef.current;
    return () => {
      tasks.forEach((t) => t.cancel());
      tasks.clear();
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    };
  }, []);

  const totalHeight = useMemo(() => {
    if (pages.length === 0) return 0;
    const last = pages[pages.length - 1];
    return last.offsetTop + last.height;
  }, [pages]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-auto"
      style={{
        // Apply theming via CSS filter — same as the previous iframe approach
        // so Light/Sepia/Dark color logic is preserved verbatim.
        filter: MODE_FILTER[mode],
        transition: "filter .25s ease",
      }}
    >
      {/* Inner positioning surface: total document height so virtualized pages
          can be absolutely positioned and the scrollbar reflects the full doc. */}
      <div
        ref={innerRef}
        className="relative mx-auto"
        style={{
          width: containerWidth || "100%",
          height: totalHeight,
          paddingTop: 12,
        }}
      >
        {pages.map((p) => (
          <div
            key={p.pageNumber}
            ref={(el) => {
              if (el) pageRefs.current.set(p.pageNumber, el);
              else pageRefs.current.delete(p.pageNumber);
            }}
            data-page={p.pageNumber}
            className="pdf-page absolute"
            style={{
              top: p.offsetTop + 12,
              left: 0,
              width: p.width,
              height: p.height,
              background: PAGE_BG[mode],
              boxShadow:
                mode === "dark"
                  ? "0 4px 14px -6px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)"
                  : "0 4px 14px -6px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.04)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          />
        ))}

        {/* Loading overlay — only shown until first layout completes. */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-full text-[12px] text-slate-300"
              style={{
                background: "rgba(12,14,20,0.65)",
                border: "1px solid rgba(255,255,255,0.08)",
                backdropFilter: "blur(6px)",
              }}
            >
              <Loader2 size={14} className="animate-spin" />
              Loading PDF…
            </div>
          </div>
        )}

        {/* Error overlay. */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div
              className="max-w-md text-center text-[13px] text-slate-300 px-4 py-3 rounded-lg"
              style={{
                background: "rgba(12,14,20,0.75)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div className="font-semibold mb-1">Couldn’t load PDF</div>
              <div className="text-slate-400 text-[11px] break-all">
                {fileUrl}
              </div>
              <div className="text-slate-500 text-[11px] mt-1">{error}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers

type OutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
};

async function flattenOutline(
  doc: PDFDocumentProxy,
  outline: OutlineNode[] | null | undefined,
  depth = 0,
  acc: RailSection[] = [],
): Promise<RailSection[]> {
  if (!outline) return acc;
  for (const node of outline) {
    const pageIndex = await resolveOutlinePage(doc, node);
    if (pageIndex != null && typeof node.title === "string") {
      acc.push({ title: node.title, pageIndex, depth });
    }
    if (node.items?.length) {
      await flattenOutline(doc, node.items, depth + 1, acc);
    }
  }
  return acc;
}

async function resolveOutlinePage(
  doc: PDFDocumentProxy,
  node: OutlineNode,
): Promise<number | null> {
  try {
    let dest: unknown[] | null = null;
    if (typeof node.dest === "string") {
      dest = await doc.getDestination(node.dest);
    } else if (Array.isArray(node.dest)) {
      dest = node.dest;
    }
    if (!dest || dest.length === 0) return null;
    const ref = dest[0];
    if (
      ref &&
      typeof ref === "object" &&
      "num" in ref &&
      "gen" in ref
    ) {
      const idx = await doc.getPageIndex(ref as { num: number; gen: number });
      return idx;
    }
    if (typeof ref === "number") return ref; // Already a page index in some PDFs.
    return null;
  } catch {
    return null;
  }
}
