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
  // Mermaid v11 still emits node labels as <foreignObject><div>…</div></foreignObject>
  // even with flowchart.htmlLabels=false, so the strict SVG profile alone
  // leaves every node empty. We allow the foreignObject wrapper + the safe
  // HTML tags mermaid uses inside (div/span/p/br) while keeping the rest of
  // the strict profile — no <script>, <iframe>, event handlers, etc.
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["xmlns", "requiredExtensions"],
  });
}

/**
 * Auto-fix two common AI-output glitches that crash the mermaid parser:
 *
 * 1. Parentheses / braces in bracketed labels. Mermaid parses `A[foo()]` as
 *    "id A, shape [foo, sub-shape (… )]", which errors. Wrapping the label in
 *    quotes (`A["foo()"]`) resolves it.
 * 2. Edge pipe-labels containing problematic chars. Same fix: wrap in quotes
 *    when needed.
 *
 * Idempotent: labels already quoted are left alone.
 */
function sanitizeMermaidSource(src: string): string {
  // A[...]  — node with square-bracket shape. Quote label if it has (){}.
  // Skip lines that start with ``` to avoid touching fences (shouldn't see
  // any here, but defense in depth).
  const rewrite = (whole: string, id: string, body: string) => {
    if (body.startsWith('"') && body.endsWith('"')) return whole;
    if (!/[(){}]/.test(body)) return whole;
    const escaped = body.replace(/"/g, '&quot;');
    return `${id}["${escaped}"]`;
  };
  return src
    // Rectangular:   A[label]
    .replace(/(\b[A-Za-z0-9_]+)\[([^\[\]\n]+)\]/g, rewrite)
    // Edge pipe label:  -->|label|  A    (only when problem chars are present)
    .replace(/\|([^|\n]+)\|/g, (whole, body) => {
      if (body.startsWith('"') && body.endsWith('"')) return whole;
      if (!/[(){}]/.test(body)) return whole;
      return `|"${body.replace(/"/g, "&quot;")}"|`;
    });
}

function useMermaidSvg(code: string, appMode: string) {
  const id = useId().replace(/:/g, "_");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // htmlLabels=false forces mermaid to emit plain <text> nodes instead of
    // wrapping labels in <foreignObject><div>…</div></foreignObject>. Our
    // DOMPurify SVG profile strips foreignObject, which was leaving every
    // node/edge label blank. SVG text is rendered natively and survives the
    // sanitizer pass.
    mermaid.initialize({
      startOnLoad: false,
      theme: appMode === "light" ? "default" : "dark",
      securityLevel: "strict",
      fontFamily: "Inter, system-ui, sans-serif",
      flowchart: { htmlLabels: false, useMaxWidth: true },
    });
  }, [appMode]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      const cleaned = sanitizeMermaidSource(code.trim());
      try {
        const result = await mermaid.render(`m-${id}`, cleaned);
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
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Esc closes from anywhere, regardless of focus. capture=true catches the
  // event before any child handler can stop it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setScale((s) => Math.max(0.3, Math.min(8, s * (1 + delta))));
  }
  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    setTx(dragRef.current.tx + (e.clientX - dragRef.current.x));
    setTy(dragRef.current.ty + (e.clientY - dragRef.current.y));
  }
  function onPointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setDragging(false);
  }
  function reset() { setScale(1); setTx(0); setTy(0); }

  return (
    <div
      role="dialog"
      aria-label="Zoomed Mermaid diagram"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm mermaid-zoom-host"
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
          aria-label="Close (Esc)"
          title="Close (Esc)"
          onClick={onClose}
          className="absolute top-3 right-3 z-20 inline-flex items-center justify-center w-9 h-9 rounded-full bg-rose-500/20 border border-rose-400/40 text-rose-200 hover:bg-rose-500/40 hover:text-white cursor-pointer shadow-lg"
        >
          <X size={16} />
        </button>
        <div className="absolute bottom-3 left-3 z-10 text-[10px] px-2 py-1 rounded bg-white/[0.06] border border-white/10 text-slate-400 pointer-events-none">
          scroll = zoom · drag = pan · dbl-click = reset · Esc = close
        </div>
        <div
          className={`w-full h-full ${dragging ? "cursor-grabbing" : "cursor-grab"} select-none`}
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
              transition: dragging ? "none" : "transform 80ms ease-out",
            }}
          >
            <SvgHost svg={svg} className="mermaid-zoom-svg" />
          </div>
        </div>
      </div>
    </div>
  );
}
