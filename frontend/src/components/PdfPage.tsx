import { useCallback, useEffect, useRef, useState } from "react";
import { Sun, Book, Moon, Printer } from "lucide-react";
import { useUiStore, type ReadingMode } from "@/stores/ui-store";
import type { HighlightColor } from "@/lib/api";
import { ReadingProgressRail, type RailSection } from "./ReadingProgressRail";
import {
  PdfViewport,
  type HighlightWithPosition,
  type SelectionPayload,
} from "./PdfViewport";
import { SelectionToolbar } from "./SelectionToolbar";

/**
 * The arXiv ID pill in the floating toolbar. Click copies `arxiv:{id}` to the
 * clipboard and flashes "Copied" for ~1.2s; Shift+click opens the paper on
 * arxiv.org in a new tab. Visual style is unchanged from the prior decorative
 * span — this is an additive affordance.
 */
function ArxivPill({ arxivId }: { arxivId: string }) {
  const [flash, setFlash] = useState<"idle" | "copied" | "error">("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  function scheduleClear() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setFlash("idle");
      timerRef.current = null;
    }, 1200);
  }

  function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (e.shiftKey) {
      window.open(`https://arxiv.org/abs/${arxivId}`, "_blank", "noopener,noreferrer");
      return;
    }
    const text = `arxiv:${arxivId}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => { setFlash("copied"); scheduleClear(); })
        .catch(() => { setFlash("error"); scheduleClear(); });
    } else {
      setFlash("error");
      scheduleClear();
    }
  }

  const label =
    flash === "copied" ? "Copied" :
    flash === "error"  ? "Copy failed" :
    `arXiv:${arxivId}`;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Copy arxiv id ${arxivId}. Shift-click to open on arxiv.org.`}
      title="Click to copy · Shift+click to open on arxiv.org"
      className="font-mono text-[11px] px-2 py-0.5 rounded-full cursor-pointer transition-colors hover:brightness-110"
      style={{
        color: "var(--ac1)",
        background: "var(--ac1-soft)",
        border: "1px solid var(--ac1-mid)",
      }}
    >
      {label}
    </button>
  );
}

type Props = {
  fileUrl: string;
  mode: ReadingMode;
  arxivId?: string;
  highlights?: HighlightWithPosition[];
  selection?: SelectionPayload | null;
  onSelection?: (p: SelectionPayload | null) => void;
  jumpRef?: React.MutableRefObject<((n: number) => void) | null>;
  onHighlightSave?: (color: HighlightColor) => Promise<void>;
  onHighlightAsk?: () => void;
  defaultHighlightColor?: HighlightColor;
};

// Reading mode tints the *card surround only* — the PDF page itself keeps
// its own intrinsic paper color. Translucent so the app backdrop (glass
// mesh) reads through cleanly; without this, in app-light + reading-dark
// you get a hard dark rectangle framing the page. Subtle is key here.
const MODE_BG: Record<ReadingMode, string> = {
  light: "rgba(244, 247, 252, 0.35)",
  sepia: "rgba(248, 239, 217, 0.45)",
  dark:  "rgba(18, 22, 32, 0.45)",
};

const HIDE_AFTER_MS = 1500;

const MODES: { id: ReadingMode; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "sepia", label: "Sepia", Icon: Book },
  { id: "dark",  label: "Dark",  Icon: Moon },
];

/**
 * Open the browser's print dialog for the whole PDF. We mount a same-origin
 * hidden iframe pointed at the PDF URL, wait for load, then call print() on
 * its contentWindow — that gives Chrome/Safari a proper PDF print preview
 * instead of the React app's DOM. The iframe self-removes after a minute;
 * there's no reliable cross-browser signal for when the print dialog closes.
 */
function printPdf(fileUrl: string) {
  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  iframe.src = fileUrl;
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      window.open(fileUrl, "_blank", "noopener,noreferrer");
    }
    window.setTimeout(() => iframe.remove(), 60_000);
  };
  document.body.appendChild(iframe);
}

export function PdfPage({
  fileUrl,
  mode,
  arxivId,
  highlights,
  selection,
  onSelection,
  jumpRef: externalJumpRef,
  onHighlightSave,
  onHighlightAsk,
  defaultHighlightColor = "yellow",
}: Props) {
  const setMode = useUiStore((s) => s.setReadingMode);
  const jumpToPageRequest = useUiStore((s) => s.jumpToPageRequest);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const hideTimer = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const internalJumpRef = useRef<((pageNumber: number) => void) | null>(null);
  const jumpRef = externalJumpRef ?? internalJumpRef;

  // Scroll/resize re-evaluation for the floating SelectionToolbar. The toolbar's
  // absolute position is computed from getBoundingClientRect() of the page
  // element relative to the card; when the inner PDF scroll container scrolls
  // or the window resizes, those rects change but nothing else in React state
  // does — so without this tick the toolbar detaches from its selection.
  const [, setScrollTick] = useState(0);

  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    scrollRatio: number;
  } | null>(null);
  const [sections, setSections] = useState<RailSection[]>([]);

  // PdfViewport's progress effect depends on the onProgress callback
  // identity — an inline arrow would re-fire the effect on every render
  // and trigger an infinite setState loop (the PDF's onProgress → parent
  // setProgress → new arrow → effect re-runs). useCallback keeps it stable.
  const onProgress = useCallback(
    (p: { current: number; total: number; scrollRatio: number }) => {
      setProgress((prev) =>
        prev &&
        prev.current === p.current &&
        prev.total === p.total &&
        prev.scrollRatio === p.scrollRatio
          ? prev
          : { current: p.current, total: p.total, scrollRatio: p.scrollRatio },
      );
    },
    [],
  );

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        setScrollTick((n) => (n + 1) & 0xffff);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const onResize = () => setScrollTick((n) => (n + 1) & 0xffff);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Bridge the global "jump to page" action (fired from chat link clicks) to
  // the imperative jumpRef the viewport already exposes. Action-id pattern
  // means re-clicking the same `[Sec. 4.2 (p.7)](page:7)` link fires every
  // time even when the page number is identical.
  useEffect(() => {
    if (!jumpToPageRequest) return;
    jumpRef.current?.(jumpToPageRequest.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToPageRequest?.id]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const scheduleHide = () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
      hideTimer.current = window.setTimeout(() => {
        setToolbarVisible(false);
      }, HIDE_AFTER_MS);
    };

    // Document-level mousemove still works because we hit-test against the
    // card's bounding rect — independent of which child element captures
    // events. Kept for parity with the iframe-era behaviour.
    const onDocMove = (e: MouseEvent) => {
      const rect = card.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (inside) {
        setToolbarVisible(true);
        scheduleHide();
      }
    };

    // The pdfjs scroll container is now a normal DOM node, so a plain
    // mouseenter listener works directly (no iframe event capture to dodge).
    const onScrollAreaOver = () => {
      setToolbarVisible(true);
      scheduleHide();
    };
    const scrollEl = scrollContainerRef.current;
    scrollEl?.addEventListener("mouseenter", onScrollAreaOver);

    document.addEventListener("mousemove", onDocMove);
    scheduleHide();

    return () => {
      document.removeEventListener("mousemove", onDocMove);
      scrollEl?.removeEventListener("mouseenter", onScrollAreaOver);
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
    };
  }, []);

  return (
    <div
      ref={cardRef}
      className="relative rounded-2xl overflow-hidden h-full"
      style={{
        background: MODE_BG[mode],
        transition: "background .35s ease",
        // Accent ring only — drop shadows cast a dark halo onto the aurora
        // backdrop which reads as a heavy black smear under the card.
        boxShadow: "0 0 0 1px var(--ac1-mid)",
      }}
    >

      {/* Reading-progress rail — sits on the left edge of the card and now
          tracks real scroll position + page count + outline sections. */}
      <ReadingProgressRail
        progress={
          progress ? { ...progress, sections } : null
        }
        onJumpToPage={(p) => jumpRef.current?.(p)}
      />

      {/* The actual document — floats over the gradient with a 2px accent ring */}
      <div
        className="absolute inset-2 rounded-xl overflow-hidden"
        style={{
          boxShadow:
            "0 0 0 2px var(--ac1-mid), 0 18px 40px -18px rgba(0,0,0,0.55)",
          background:
            mode === "dark" ? "#1a1c22" : mode === "sepia" ? "#f4ead4" : "#ffffff",
          transition: "background .25s ease, box-shadow .25s ease",
        }}
      >
        <PdfViewport
          fileUrl={fileUrl}
          mode={mode}
          scrollContainerRef={scrollContainerRef}
          jumpRef={jumpRef}
          onProgress={onProgress}
          onSections={setSections}
          onSelection={onSelection}
          highlights={highlights}
        />
      </div>

      {/* Floating selection toolbar — pinned above the last selection rect. */}
      {selection && selection.rects.length > 0 && onHighlightSave && onHighlightAsk && (() => {
        const scrollEl = scrollContainerRef.current;
        const pageEl = scrollEl?.querySelector(
          `.pdf-page[data-page="${selection.page}"]`,
        ) as HTMLElement | null;
        const cardRect = cardRef.current?.getBoundingClientRect();
        if (!scrollEl || !pageEl || !cardRect) return null;
        const pageRect = pageEl.getBoundingClientRect();
        const last = selection.rects[selection.rects.length - 1];
        const centerX =
          pageRect.left - cardRect.left + (last.x + last.width / 2) * pageRect.width;
        const topY = pageRect.top - cardRect.top + last.y * pageRect.height;
        return (
          <SelectionToolbar
            left={centerX}
            top={Math.max(topY - 6, 12)}
            color={defaultHighlightColor}
            onHighlight={(color) => void onHighlightSave(color)}
            onAsk={onHighlightAsk}
          />
        );
      })()}

      {/* Floating auto-hiding toolbar over the top edge */}
      <div
        className="absolute left-1/2 top-3 -translate-x-1/2 z-10"
        style={{
          opacity: toolbarVisible ? 1 : 0,
          transform: `translateX(-50%) translateY(${toolbarVisible ? "0" : "-8px"})`,
          transition: "opacity .2s ease, transform .2s ease",
          pointerEvents: toolbarVisible ? "auto" : "none",
        }}
      >
        <div
          className="flex items-center gap-2 rounded-full px-2 py-1 backdrop-blur-md"
          style={{
            background: "var(--surface-overlay)",
            border: "1px solid var(--surface-overlay-border)",
            color: "var(--surface-overlay-text)",
            boxShadow:
              "0 8px 24px -10px rgba(0,0,0,0.35), 0 0 0 1px var(--surface-overlay-border)",
          }}
        >
          {arxivId ? <ArxivPill arxivId={arxivId} /> : null}
          <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] p-0.5 border border-white/5">
            {MODES.map(({ id, label, Icon }) => {
              const active = mode === id;
              return (
                <button
                  key={id}
                  onClick={() => setMode(id)}
                  aria-pressed={active}
                  aria-label={`${label} reading mode`}
                  className={[
                    "px-2 py-0.5 rounded-full text-[11px] flex items-center gap-1 transition-colors",
                    active
                      ? "text-[color:var(--ac1)] bg-[color:var(--ac1-soft)] border border-[color:var(--ac1-mid)]"
                      : "text-slate-300 border border-transparent hover:text-white",
                  ].join(" ")}
                >
                  <Icon size={12} /> {label}
                </button>
              );
            })}
          </span>
          <button
            type="button"
            onClick={() => printPdf(fileUrl)}
            aria-label="Print PDF"
            title="Print PDF"
            className="px-2 py-1 rounded-full text-[11px] flex items-center gap-1 text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <Printer size={12} /> Print
          </button>
        </div>
      </div>
    </div>
  );
}
