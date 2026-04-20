import { useEffect, useRef, useState } from "react";
import { Sun, Book, Moon } from "lucide-react";
import { useUiStore, type ReadingMode } from "@/stores/ui-store";

type Props = {
  fileUrl: string;
  mode: ReadingMode;
  arxivId?: string;
};

const MODE_FILTER: Record<ReadingMode, string> = {
  light: "none",
  sepia: "sepia(0.5) hue-rotate(-12deg) saturate(1.1) brightness(0.97)",
  dark:  "invert(0.92) hue-rotate(180deg)",
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

    const onMove = (e: MouseEvent) => {
      const rect = card.getBoundingClientRect();
      const yFromTop = e.clientY - rect.top;
      // show if mouse is in upper 25% (or anywhere if already visible & moving)
      if (yFromTop < rect.height * 0.25) {
        setToolbarVisible(true);
      }
      scheduleHide();
    };

    const onLeave = () => {
      scheduleHide();
    };

    card.addEventListener("mousemove", onMove);
    card.addEventListener("mouseleave", onLeave);
    scheduleHide();

    return () => {
      card.removeEventListener("mousemove", onMove);
      card.removeEventListener("mouseleave", onLeave);
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
      {/* Page-stack illusion: two faint shadows behind the iframe suggest stacked pages */}
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
        <iframe
          src={`${fileUrl}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`}
          title="PDF"
          style={{
            width: "100%",
            height: "100%",
            border: 0,
            filter: MODE_FILTER[mode],
            transition: "filter .25s ease",
            display: "block",
          }}
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
          {arxivId ? (
            <span
              className="font-mono text-[11px] px-2 py-0.5 rounded-full"
              style={{
                color: "var(--ac1)",
                background: "var(--ac1-soft)",
                border: "1px solid var(--ac1-mid)",
              }}
            >
              arXiv:{arxivId}
            </span>
          ) : null}
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
