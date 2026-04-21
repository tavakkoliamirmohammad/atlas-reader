import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { Copy, Maximize2, X } from "lucide-react";
import { useUiStore } from "@/stores/ui-store";

/**
 * Inline Mermaid flowchart renderer with click-to-zoom.
 *
 * Safety note: mermaid produces SVG markup at runtime. Because the source
 * comes from an AI response that could theoretically be prompt-injected, we
 * sanitize the SVG with DOMPurify (SVG profile) before attaching it to the
 * DOM via a ref + innerHTML — no dangerouslySetInnerHTML.
 */
type Props = { code: string };

function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}

function useMermaidSvg(code: string, appMode: string) {
  const id = useId().replace(/:/g, "_");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: appMode === "light" ? "default" : "dark",
      securityLevel: "strict",
      fontFamily: "Inter, system-ui, sans-serif",
    });
  }, [appMode]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const result = await mermaid.render(`m-${id}`, code.trim());
        if (!cancelled) setSvg(sanitizeSvg(result.svg));
      } catch (e) {
        if (!cancelled) {
          setSvg(null);
          setError((e as Error).message || "Mermaid render failed");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [code, id, appMode]);

  return { svg, error };
}

function SvgHost({ svg, className }: { svg: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = svg;
  }, [svg]);
  return <div ref={ref} className={className} />;
}

export function MermaidDiagram({ code }: Props) {
  const appMode = useUiStore((s) => s.appMode);
  const { svg, error } = useMermaidSvg(code, appMode);
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  async function copySource() {
    try {
      await navigator.clipboard.writeText(code);
    } catch { /* no-op */ }
  }

  return (
    <>
      <figure
        className="my-3 rounded-lg overflow-hidden relative group"
        style={{
          background: "var(--surface-overlay)",
          border: "1px solid var(--surface-overlay-border)",
        }}
      >
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            aria-label={showSource ? "Show diagram" : "Show Mermaid source"}
            title={showSource ? "Show diagram" : "Show source"}
            className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[color:var(--ac1-soft)] text-[color:var(--ac1)] border border-[color:var(--ac1-mid)] hover:brightness-110 cursor-pointer"
          >
            {showSource ? "diagram" : "source"}
          </button>
          <button
            type="button"
            onClick={copySource}
            aria-label="Copy Mermaid source"
            title="Copy Mermaid source"
            className="inline-flex items-center justify-center w-6 h-6 rounded bg-[color:var(--ac1-soft)] text-[color:var(--ac1)] border border-[color:var(--ac1-mid)] hover:brightness-110 cursor-pointer"
          >
            <Copy size={11} />
          </button>
          {svg && !showSource && (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              aria-label="Zoom diagram"
              title="Zoom"
              className="inline-flex items-center justify-center w-6 h-6 rounded bg-[color:var(--ac1-soft)] text-[color:var(--ac1)] border border-[color:var(--ac1-mid)] hover:brightness-110 cursor-pointer"
            >
              <Maximize2 size={11} />
            </button>
          )}
        </div>

        {showSource ? (
          <pre
            className="m-0 p-3 text-[11px] leading-snug overflow-x-auto font-mono"
            style={{ color: "var(--surface-overlay-text)" }}
          >
            {code}
          </pre>
        ) : error ? (
          <div className="p-3 text-[11px] text-rose-400">
            Mermaid render failed: {error}
          </div>
        ) : svg ? (
          <SvgHost svg={svg} className="flex items-center justify-center p-3 overflow-x-auto" />
        ) : (
          <div className="p-3 text-[11px] text-slate-500">Rendering diagram…</div>
        )}
      </figure>

      {zoomed && svg && (
        <ZoomedModal svg={svg} onClose={() => setZoomed(false)} />
      )}
    </>
  );
}


function ZoomedModal({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setScale((s) => Math.max(0.3, Math.min(8, s * (1 + delta))));
  }
  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    setTx(dragRef.current.tx + (e.clientX - dragRef.current.x));
    setTy(dragRef.current.ty + (e.clientY - dragRef.current.y));
  }
  function onPointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }
  function reset() { setScale(1); setTx(0); setTy(0); }

  return (
    <div
      role="dialog"
      aria-label="Zoomed Mermaid diagram"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-[min(95vw,1200px)] h-[min(90vh,800px)] rounded-xl overflow-hidden shadow-2xl"
        style={{
          background: "var(--surface-overlay)",
          border: "1px solid var(--surface-overlay-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/[0.06] border border-white/10 text-slate-300 hover:text-slate-100 cursor-pointer"
        >
          <X size={14} />
        </button>
        <div className="absolute bottom-3 left-3 z-10 text-[10px] px-2 py-1 rounded bg-white/[0.06] border border-white/10 text-slate-400 pointer-events-none">
          scroll to zoom · drag to pan · double-click to reset
        </div>
        <div
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={reset}
        >
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              transformOrigin: "center",
              transition: dragRef.current ? "none" : "transform 80ms ease-out",
            }}
          >
            <SvgHost svg={svg} className="" />
          </div>
        </div>
      </div>
    </div>
  );
}
