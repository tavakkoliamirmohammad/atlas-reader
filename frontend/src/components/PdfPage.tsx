import { useCallback, useEffect, useRef, useState } from "react";
import { Sun, Book, Moon } from "lucide-react";
import { useUiStore, type ReadingMode } from "@/stores/ui-store";
import { ReadingProgressRail, type RailSection } from "./ReadingProgressRail";
import { PdfViewport } from "./PdfViewport";

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
};

// Soft radial-gradient backdrops — slightly tinted center, fading to ink
const MODE_BG: Record<ReadingMode, string> = {
  light:
    "radial-gradient(ellipse 90% 70% at 50% 30%, rgba(244,247,252,1) 0%, rgba(232,236,244,1) 55%, rgba(216,222,232,1) 100%)",
  sepia:
    "radial-gradient(ellipse 90% 70% at 50% 30%, rgba(248,239,217,1) 0%, rgba(241,231,205,1) 55%, rgba(228,217,189,1) 100%)",
  dark:
    "radial-gradient(ellipse 90% 70% at 50% 30%, rgba(28,30,38,1) 0%, rgba(20,22,30,1) 55%, rgba(12,13,18,1) 100%)",
};

const HIDE_AFTER_MS = 1500;

const MODES: { id: ReadingMode; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "sepia", label: "Sepia", Icon: Book },
  { id: "dark",  label: "Dark",  Icon: Moon },
];

export function PdfPage({ fileUrl, mode, arxivId }: Props) {
  const setMode = useUiStore((s) => s.setReadingMode);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const hideTimer = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const jumpRef = useRef<((pageNumber: number) => void) | null>(null);

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
        // Subtle outer ring of accent color glow
        boxShadow:
          "0 0 0 1px var(--ac1-mid), 0 24px 60px -20px rgba(0,0,0,0.55), 0 8px 20px -10px rgba(0,0,0,0.45)",
      }}
    >
      {/* Page-stack illusion: two faint shadows behind the viewport suggest stacked pages */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-3 bottom-6 rounded-xl"
        style={{
          background: "transparent",
          boxShadow:
            "0 14px 28px -14px rgba(0,0,0,0.45), 0 28px 56px -28px rgba(0,0,0,0.35)",
          transform: "translateY(6px) scale(0.985)",
          opacity: 0.6,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-4 top-2 bottom-4 rounded-xl"
        style={{
          background: "transparent",
          boxShadow:
            "0 10px 20px -10px rgba(0,0,0,0.35), 0 20px 40px -20px rgba(0,0,0,0.25)",
          transform: "translateY(3px) scale(0.992)",
          opacity: 0.5,
        }}
      />

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
        />
      </div>

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
          className="flex items-center gap-2 rounded-full border border-white/10 px-2 py-1 backdrop-blur-md"
          style={{
            background: "rgba(12,14,20,0.65)",
            boxShadow:
              "0 8px 24px -10px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)",
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
        </div>
      </div>
    </div>
  );
}
