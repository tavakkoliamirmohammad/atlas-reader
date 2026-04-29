import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
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

// Canvases and page shells are painted WHITE in every mode. The scroll
// container's CSS `filter:` themes them uniformly (sepia via sepia/hue-rotate,
// dark via invert/hue-rotate). Painting the canvas dark and THEN inverting
// collapses contrast — that's the "washed-out PDF" bug.
const PAGE_BG_RENDER = "#ffffff";
const PAGE_BG_SHELL = "#ffffff";

const GAP = 12; // vertical gap between pages, px
const VIEWPORTS_AHEAD = 2; // render this many viewports of pages above + below visible area
const RENDER_LRU_LIMIT = 12;

type LoadPhase =
  | { kind: "fetching"; loaded: number; total: number }
  | { kind: "parsing" }
  | { kind: "layout"; done: number; total: number };

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SelectionPayload = {
  text: string;
  page: number; // 1-based
  rects: SelectionRect[]; // in normalized PDF coords (0..1 of page width/height)
};

export type HighlightWithPosition = {
  id: number | string;
  page: number; // 1-based
  color: string; // any valid CSS color (rgba preferred for translucency)
  rects: SelectionRect[]; // in normalized PDF coords
};

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
  /**
   * Fires on selection change inside the viewport. `null` means selection was
   * cleared (e.g. user clicked elsewhere).
   */
  onSelection?: (payload: SelectionPayload | null) => void;
  /** Optional in-PDF highlight overlays. */
  highlights?: HighlightWithPosition[];
  /** Click on a highlight rectangle. */
  onHighlightClick?: (id: number | string) => void;
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
  onSelection,
  highlights,
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
  const [loadPhase, setLoadPhase] = useState<LoadPhase>({
    kind: "fetching",
    loaded: 0,
    total: 0,
  });
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
  //
  // During a drag, ResizeObserver fires on every pixel. Each firing would
  // trigger a full page-meta recompute (getPage+getViewport × numPages) and
  // a repaint of every visible canvas. That's the "resize is slow / not
  // smooth" symptom. Strategy: apply the first width synchronously so first
  // paint is correct, then debounce subsequent changes ~140ms so a settled
  // drag triggers a single recompute. Mid-drag, canvases stretch via CSS —
  // slightly blurry, but snaps back on release.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const padding = 24;
    const apply = () => setContainerWidth(Math.max(0, node.clientWidth - padding));
    apply();
    let timer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(apply, 140);
    });
    ro.observe(node);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      ro.disconnect();
    };
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
    setLoadPhase({ kind: "fetching", loaded: 0, total: 0 });
    setError(null);
    setPages([]);
    setCurrentPage(1);
    /* eslint-enable react-hooks/set-state-in-effect */
    renderedOrderRef.current = [];
    renderedSetRef.current = new Set();
    renderTasksRef.current.forEach((t) => t.cancel());
    renderTasksRef.current.clear();
    // Clear canvas + text layer from any wraps that React reuses across the
    // paper switch (React matches by key=pageNumber, so wraps for pages 1..N
    // in the old doc become slots for 1..N in the new doc with their old
    // children still attached). Without this clear, the old paper's rendered
    // content stays visible and the new renderPage races with itself to
    // overwrite it — the "click a paper, PDF doesn't update" bug.
    pageRefs.current.forEach((wrap) => {
      wrap.querySelector("canvas.pdf-canvas")?.remove();
      wrap.querySelector(".textLayer")?.remove();
    });
    pageRefs.current.clear();

    // enableHWA asks the browser for a GPU-backed 2D canvas. Softness /
    // stroke weight are unchanged vs. the software-raster path; the backing
    // store just composites faster and scales more cleanly on HiDPI.
    const loadingTask = pdfjsLib.getDocument({ url: fileUrl, enableHWA: true });
    loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (cancelled) return;
      setLoadPhase({ kind: "fetching", loaded, total });
    };
    loadingTask.promise
      .then(async (doc) => {
        if (cancelled) {
          doc.destroy();
          return;
        }
        setLoadPhase({ kind: "parsing" });
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
      setLoadPhase({ kind: "layout", done: 0, total: doc.numPages });
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
        setLoadPhase({ kind: "layout", done: i, total: doc.numPages });
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

        // alpha: false — the page is painted opaque white, so per-pixel
        // alpha blending buys nothing. Opaque contexts composite slightly
        // faster and in some browsers avoid a gamma-mismatch softening on
        // dark backgrounds. Softness of rasterized glyphs unchanged.
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;
        // "high" swaps the default bilinear downsample for a Lanczos-style
        // filter — only matters when the canvas is scaled back to CSS px
        // (DPR > 1 on Retina, or if we ever supersample). On DPR 1 this
        // rule never fires, so softness on 1× displays is unchanged.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        const transform: [number, number, number, number, number, number] | undefined =
          dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;

        const task = page.render({
          canvasContext: ctx,
          viewport,
          transform,
          background: PAGE_BG_RENDER,
        } as Parameters<PDFPageProxy["render"]>[0]);
        renderTasksRef.current.set(pageNumber, task);
        await task.promise;
        renderTasksRef.current.delete(pageNumber);

        // Render the text layer (Phase 2).
        await renderTextLayerFor(page, viewport, wrap);

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
            // Drop canvas + text layer to free memory; placeholder remains.
            evictWrap.querySelector("canvas.pdf-canvas")?.remove();
            evictWrap.querySelector(".textLayer")?.remove();
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

  // Invalidate rendered canvases when the `pages` layout changes to a new
  // scale (container resized). The existing canvases were drawn at the OLD
  // scale — the "PDF badly resized" bug. This effect runs BEFORE the
  // visible-range effect below (declaration order) so by the time
  // visible-range calls renderPage, the renderedSet has been cleared and
  // renderPage actually repaints instead of short-circuiting.
  //
  // Skip the empty→non-empty transition (initial load + every paper switch):
  // no canvases exist, no invalidation needed, and we don't want to cancel
  // the first renders either.
  const prevPagesRef = useRef<PageMeta[]>([]);
  useEffect(() => {
    const prev = prevPagesRef.current;
    prevPagesRef.current = pages;
    if (pages.length === 0 || prev.length === 0) return;
    const sameScale =
      prev.length === pages.length && prev[0].scale === pages[0].scale;
    if (sameScale) return;
    renderedSetRef.current.clear();
    renderedOrderRef.current = [];
    renderTasksRef.current.forEach((t) => t.cancel());
    renderTasksRef.current.clear();
    pageRefs.current.forEach((wrap) => {
      wrap.querySelector("canvas.pdf-canvas")?.remove();
      wrap.querySelector(".textLayer")?.remove();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

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

  // Invalidate canvases when the container is resized (every page now has a
  // new scale; old canvases would overlap the new slot at wrong dimensions —
  // the "PDF badly resized" bug).
  //
  // Critical: skip the empty→non-empty transition. That fires on initial load
  // AND on every fileUrl switch — and the visible-range effect just queued
  // the first renders for the new doc. If we cancel them here the new PDF
  // never paints (the "click a paper / type a URL and the PDF doesn't update"
  // bug). Only invalidate when scale actually changed.

  // Selection wiring (Phase 2). Listen to document selectionchange and decide
  // whether the selection lives inside our viewport. Debounce slightly so we
  // don't flood the parent during drag-select.
  useEffect(() => {
    if (!onSelection) return;
    const node = containerRef.current;
    if (!node) return;
    let timer: number | null = null;

    const compute = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        onSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      // Confirm selection is inside our scroll container.
      if (!node.contains(range.commonAncestorContainer)) {
        return; // Not ours — ignore (don't even fire null, the selection is elsewhere).
      }
      // Find the page wrap that contains the selection start.
      const startEl =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const pageWrap = startEl?.closest(".pdf-page") as HTMLElement | null;
      const pageNum = pageWrap ? Number(pageWrap.dataset.page || "0") : 0;
      if (!pageWrap || !pageNum) {
        onSelection(null);
        return;
      }

      const pageRect = pageWrap.getBoundingClientRect();
      const w = pageRect.width || 1;
      const h = pageRect.height || 1;
      // Convert client rects to normalized page-relative coords.
      const rects: SelectionRect[] = [];
      const clientRects = range.getClientRects();
      for (let i = 0; i < clientRects.length; i++) {
        const r = clientRects[i];
        if (r.width === 0 || r.height === 0) continue;
        rects.push({
          x: (r.left - pageRect.left) / w,
          y: (r.top - pageRect.top) / h,
          width: r.width / w,
          height: r.height / h,
        });
      }
      if (rects.length === 0) {
        onSelection(null);
        return;
      }
      onSelection({
        text: sel.toString(),
        page: pageNum,
        rects,
      });
    };

    const handler = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(compute, 100);
    };

    document.addEventListener("selectionchange", handler);
    return () => {
      document.removeEventListener("selectionchange", handler);
      if (timer) window.clearTimeout(timer);
    };
  }, [onSelection]);

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

  // Group highlights by page for quick lookup.
  const highlightsByPage = useMemo(() => {
    const m = new Map<number, HighlightWithPosition[]>();
    if (!highlights) return m;
    for (const h of highlights) {
      const arr = m.get(h.page) ?? [];
      arr.push(h);
      m.set(h.page, arr);
    }
    return m;
  }, [highlights]);

  const totalHeight = useMemo(() => {
    if (pages.length === 0) return 0;
    const last = pages[pages.length - 1];
    return last.offsetTop + last.height;
  }, [pages]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-auto"
      style={{
        // Apply theming via CSS filter — same as the previous iframe approach
        // so Light/Sepia/Dark color logic is preserved verbatim.
        filter: MODE_FILTER[mode],
        transition: "filter .25s ease",
      }}
    >
      {/* Centered initial-fetch loader. Lives at the OUTER container level
          (not inside the inner positioning surface) because that surface
          has `height: totalHeight` which is 0 while loading — an
          `absolute inset-0` child of a zero-height parent paints nothing. */}
      {loading && pages.length === 0 && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none px-6 z-20"
          aria-live="polite"
        >
          <InitialPdfLoadingCard phase={loadPhase} />
        </div>
      )}

      {/* Inner positioning surface: total document height so virtualized pages
          can be absolutely positioned and scrollbar reflects the full doc. */}
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
              background: PAGE_BG_SHELL,
              boxShadow:
                "0 4px 14px -6px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.04)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            {/* Highlight overlay (Phase 2). Sized in normalized PDF coords. */}
            {highlightsByPage.get(p.pageNumber)?.map((hl) => (
              <div
                key={`hl-${hl.id}`}
                className="absolute pointer-events-none"
                style={{ inset: 0 }}
              >
                {hl.rects.map((r, i) => (
                  <div
                    key={`hl-${hl.id}-${i}`}
                    role="button"
                    aria-label="highlight"
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        // Re-enable pointer events for the rect itself so
                        // clicks land here, but keep selection working through
                        // the rest of the overlay.
                      }
                    }}
                    className="absolute"
                    style={{
                      left: `${r.x * 100}%`,
                      top: `${r.y * 100}%`,
                      width: `${r.width * 100}%`,
                      height: `${r.height * 100}%`,
                      background: hl.color,
                      mixBlendMode: mode === "dark" ? "screen" : "multiply",
                      pointerEvents: "auto",
                      cursor: "pointer",
                      borderRadius: 2,
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        ))}

        {/* Bottom progress card — richer, with download progress + phase.
            Visible during parsing / page prep, when the centered card has
            already faded out and page placeholders are filling the area. */}
        <GatedLoadingCard loading={loading} phase={loadPhase} />

        {/* Error overlay. */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-6 pointer-events-none">
            <div
              className="max-w-md text-center text-[13px] px-4 py-3 rounded-lg"
              style={{
                background: "var(--surface-overlay)",
                border: "1px solid var(--surface-overlay-border)",
                color: "var(--surface-overlay-text)",
              }}
            >
              <div className="font-semibold mb-1">Couldn’t load PDF</div>
              <div className="text-[11px] break-all" style={{ opacity: 0.7 }}>
                {fileUrl}
              </div>
              <div className="text-[11px] mt-1" style={{ opacity: 0.55 }}>{error}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading card

/**
 * Gate around LoadingCard that adds two UX rules:
 *
 * - **Show delay (150 ms):** PDFs served from the local cache load in well
 *   under 100 ms, which caused the card to appear and disappear in a single
 *   frame (not user-visible). Waiting 150 ms before first render skips those
 *   fast loads entirely.
 * - **Minimum visible duration (450 ms):** Once the card is shown, keep it
 *   on-screen long enough that the slide-up animation completes and the user
 *   actually registers the indicator — even if the underlying `loading`
 *   state flips back to `false` immediately after.
 */
function GatedLoadingCard({ loading, phase }: { loading: boolean; phase: LoadPhase }) {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number | null>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    const timers = timersRef.current;
    if (loading) {
      // Defer first render so fast loads never show anything.
      const t = window.setTimeout(() => {
        setVisible(true);
        shownAtRef.current = Date.now();
      }, 150);
      timers.push(t);
    } else if (visible) {
      // Enforce minimum visible duration before hiding.
      const elapsed = shownAtRef.current ? Date.now() - shownAtRef.current : 0;
      const remaining = Math.max(0, 450 - elapsed);
      const t = window.setTimeout(() => setVisible(false), remaining);
      timers.push(t);
    }
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
    };
  }, [loading, visible]);

  if (!visible) return null;
  return <LoadingCard phase={phase} />;
}


/**
 * Centered initial-fetch loader. Shown only while the first PDF download is
 * in flight and no pages have been laid out yet — i.e. the viewport is
 * otherwise empty and the bottom progress card is too easy to miss. As soon
 * as parsing starts and placeholders fill the viewport, this fades out and
 * the bottom card carries the rest of the loading story.
 *
 * No show-delay gate here: this is the *only* signal the user has during
 * the initial download (now that arXiv PDFs aren't disk-cached, every open
 * is a real network round trip), so any delay is wasted attention.
 */
function InitialPdfLoadingCard({ phase }: { phase: LoadPhase }) {
  let detail: string | null = null;
  let pct: number | null = null;
  let title = "Downloading PDF";
  let indeterminate = true;

  if (phase.kind === "fetching") {
    if (phase.total > 0) {
      const ratio = Math.max(0, Math.min(1, phase.loaded / phase.total));
      pct = Math.round(ratio * 100);
      detail = `${formatBytes(phase.loaded)} of ${formatBytes(phase.total)}`;
      indeterminate = false;
    } else if (phase.loaded > 0) {
      detail = formatBytes(phase.loaded);
    }
  } else if (phase.kind === "parsing") {
    title = "Parsing document";
  } else if (phase.kind === "layout") {
    title = "Preparing pages";
    if (phase.total > 0) {
      pct = Math.round((phase.done / phase.total) * 100);
      detail = `${phase.done} of ${phase.total} pages`;
      indeterminate = false;
    }
  }

  return (
    <div
      className="flex flex-col items-center gap-4 w-full max-w-[360px] text-center px-6 py-5 rounded-2xl"
      role="status"
      style={{
        // High-contrast card so the user actually sees it against any
        // viewport background — the previous version was just floating
        // text on the empty PDF area, which faded into the surroundings.
        background: "var(--surface-overlay)",
        border: "1px solid var(--ac1-mid)",
        color: "var(--surface-overlay-text)",
        backdropFilter: "blur(12px)",
        boxShadow: "0 20px 40px -12px rgba(0,0,0,0.35), 0 0 0 1px var(--ac1-mid)",
      }}
    >
      <Loader2
        size={40}
        className="animate-spin"
        style={{ color: "var(--ac1)" }}
        aria-hidden
      />
      <div className="flex flex-col gap-1">
        <div className="text-[14px] font-semibold tracking-tight">
          {title}{pct !== null ? ` · ${pct}%` : ""}
        </div>
        <div className="text-[11px] opacity-70 min-h-[1em]">
          {detail ?? "Streaming from arxiv.org…"}
        </div>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: "var(--surface-overlay-border)" }}
      >
        {indeterminate ? (
          <div
            className="h-full rounded-full pdf-loading-indeterminate"
            style={{
              width: "40%",
              background:
                "linear-gradient(90deg, transparent, var(--ac1) 50%, transparent)",
            }}
          />
        ) : (
          <div
            className="h-full rounded-full transition-[width] duration-150"
            style={{
              width: `${pct ?? 0}%`,
              background: "var(--ac1)",
            }}
          />
        )}
      </div>
    </div>
  );
}


function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function LoadingCard({ phase }: { phase: LoadPhase }) {
  // Compute a 0..1 progress value and a label for each phase.
  let ratio = 0;
  let title = "Loading PDF";
  let detail: string | null = null;
  let indeterminate = false;

  if (phase.kind === "fetching") {
    title = "Downloading PDF";
    if (phase.total > 0) {
      ratio = Math.max(0, Math.min(1, phase.loaded / phase.total));
      detail = `${formatBytes(phase.loaded)} of ${formatBytes(phase.total)}`;
    } else if (phase.loaded > 0) {
      // Content-Length missing — show bytes but keep the bar indeterminate.
      indeterminate = true;
      detail = formatBytes(phase.loaded);
    } else {
      indeterminate = true;
    }
  } else if (phase.kind === "parsing") {
    title = "Parsing document";
    indeterminate = true;
  } else {
    title = "Preparing pages";
    ratio = phase.total > 0 ? phase.done / phase.total : 0;
    detail = `${phase.done} of ${phase.total}`;
  }

  const pct = Math.round(ratio * 100);

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10 flex justify-center pointer-events-none px-6 pb-6 fade-up-bottom"
      aria-live="polite"
    >
      <div
        className="w-full max-w-[360px] rounded-xl px-4 py-3"
        style={{
          background: "var(--surface-overlay)",
          border: "1px solid var(--surface-overlay-border)",
          color: "var(--surface-overlay-text)",
          backdropFilter: "blur(10px)",
          boxShadow:
            "0 10px 30px -12px rgba(0,0,0,0.25), 0 0 0 1px var(--ac1-mid)",
        }}
      >
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Loader2 size={14} className="animate-spin" style={{ color: "var(--ac1)" }} />
          <span className="flex-1">{title}</span>
          {!indeterminate && (
            <span
              className="font-mono text-[11px] tabular-nums"
              style={{ color: "var(--ac1)" }}
            >
              {pct}%
            </span>
          )}
        </div>

        <div
          className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: "var(--surface-overlay-border)" }}
        >
          {indeterminate ? (
            <div
              className="h-full rounded-full pdf-loading-indeterminate"
              style={{
                width: "40%",
                background:
                  "linear-gradient(90deg, transparent, var(--ac1) 50%, transparent)",
              }}
            />
          ) : (
            <div
              className="h-full rounded-full transition-[width] duration-200 ease-out"
              style={{
                width: `${pct}%`,
                background:
                  "linear-gradient(90deg, var(--ac1-mid), var(--ac1))",
                boxShadow: "0 0 8px var(--ac1-mid)",
              }}
            />
          )}
        </div>

        {detail && (
          <div
            className="mt-1.5 font-mono text-[10.5px] tabular-nums"
            style={{ color: "var(--surface-overlay-muted)" }}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers

async function renderTextLayerFor(
  page: PDFPageProxy,
  viewport: PageViewport,
  wrap: HTMLElement,
) {
  // Drop any previous text layer for this page.
  wrap.querySelector(".textLayer")?.remove();
  const textContent = await page.getTextContent();
  const textDiv = document.createElement("div");
  textDiv.className = "textLayer";
  textDiv.style.setProperty("--total-scale-factor", String(viewport.scale));
  wrap.appendChild(textDiv);

  const layer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textDiv,
    viewport,
  });
  try {
    await layer.render();
  } catch {
    /* noop — text layer rendering can fail on protected docs */
  }

  // Bound drag-selection to this page: append an `endOfContent` sentinel and
  // toggle the `.selecting` class on pointerdown so the CSS rule
  // `.textLayer.selecting .endOfContent { top: 0 }` activates. Without this,
  // a selection that starts inside one page's spans extends past the last
  // span and grabs adjacent pages' content — the "select a word, get a
  // paragraph" bug. This replicates what pdfjs's own TextLayerBuilder does.
  const endOfContent = document.createElement("div");
  endOfContent.className = "endOfContent";
  textDiv.appendChild(endOfContent);
  textDiv.addEventListener("pointerdown", () => {
    textDiv.classList.add("selecting");
    const clear = () => textDiv.classList.remove("selecting");
    document.addEventListener("pointerup", clear, { once: true });
    window.addEventListener("blur", clear, { once: true });
  });
}

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
