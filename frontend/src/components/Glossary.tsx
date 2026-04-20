import { useEffect, useRef, useState } from "react";
import {
  type GlossaryTerm,
  extractGlossary,
  fetchGlossary,
  fetchGlossaryDefinition,
} from "@/lib/api";

type Props = {
  arxivId: string;
};

type DefState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

const HOVER_DELAY_MS = 200;

export function Glossary({ arxivId }: Props) {
  const [terms, setTerms] = useState<GlossaryTerm[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [hoveredTerm, setHoveredTerm] = useState<string | null>(null);
  const [defs, setDefs] = useState<Record<string, DefState>>({});
  const hoverTimerRef = useRef<number | null>(null);

  // Reset state and reload on paper switch.
  useEffect(() => {
    setTerms(null);
    setHoveredTerm(null);
    setDefs({});
    let cancelled = false;
    fetchGlossary(arxivId)
      .then((rows) => {
        if (cancelled) return;
        setTerms(rows);
        // Seed the definition cache from any rows already populated server-side.
        const seed: Record<string, DefState> = {};
        for (const r of rows) {
          if (r.definition) seed[r.term] = { status: "ready", text: r.definition };
        }
        setDefs(seed);
      })
      .catch(() => {
        if (!cancelled) setTerms([]);
      });
    return () => {
      cancelled = true;
    };
  }, [arxivId]);

  // Cleanup hover timer on unmount.
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    };
  }, []);

  async function build() {
    if (extracting) return;
    setExtracting(true);
    try {
      const rows = await extractGlossary(arxivId);
      setTerms(rows);
      const seed: Record<string, DefState> = {};
      for (const r of rows) {
        if (r.definition) seed[r.term] = { status: "ready", text: r.definition };
      }
      setDefs((prev) => ({ ...seed, ...prev }));
    } catch (e) {
      // Surface failure as a friendly empty state; keep the build button visible.
      setTerms([]);
    } finally {
      setExtracting(false);
    }
  }

  function fetchDefinition(term: string) {
    setDefs((d) => ({ ...d, [term]: { status: "loading" } }));
    fetchGlossaryDefinition(arxivId, term)
      .then((text) => setDefs((d) => ({ ...d, [term]: { status: "ready", text } })))
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        const message = raw.length > 80 ? raw.slice(0, 77) + "…" : raw;
        setDefs((d) => ({ ...d, [term]: { status: "error", message } }));
      });
  }

  function scheduleHover(term: string) {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setHoveredTerm(term);
      const cur = defs[term];
      // Auto-fetch on first hover; on error, the user clicks Retry instead.
      if (!cur) fetchDefinition(term);
    }, HOVER_DELAY_MS);
  }

  function cancelHover() {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredTerm(null);
  }

  if (terms === null) {
    return (
      <div className="px-3 py-2 border-b border-white/5">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Glossary</div>
        <div className="mt-1 text-[11px] text-slate-500">Loading…</div>
      </div>
    );
  }

  if (terms.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-white/5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Glossary</div>
          <button
            onClick={build}
            disabled={extracting}
            className="px-2 py-0.5 rounded-md text-[10px] font-semibold cursor-pointer disabled:opacity-50 bg-white/[0.04] border border-white/10 text-slate-300 hover:bg-white/[0.08] hover:border-[color:var(--ac1-mid)] transition-colors"
          >
            {extracting ? "Extracting…" : "Build glossary"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-white/5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Glossary</div>
      <div className="flex flex-wrap gap-1">
        {terms.map((t) => {
          const def = defs[t.term];
          const showTip = hoveredTerm === t.term;
          return (
            <div
              key={t.id}
              className="relative"
              onMouseEnter={() => scheduleHover(t.term)}
              onMouseLeave={cancelHover}
              onFocus={() => scheduleHover(t.term)}
              onBlur={cancelHover}
            >
              <span
                tabIndex={0}
                aria-describedby={showTip ? `glossary-tip-${t.id}` : undefined}
                className="inline-block px-2 py-0.5 rounded-md text-[11px] cursor-help border border-[color:var(--ac1-mid)] bg-[color:var(--ac1-soft)] text-slate-200 hover:translate-y-[-1px] transition-transform"
              >
                {t.term}
              </span>
              {showTip && (
                <div
                  id={`glossary-tip-${t.id}`}
                  role="tooltip"
                  className="absolute z-50 left-0 top-full mt-1 w-64 max-w-[18rem] px-2.5 py-1.5 rounded-md text-[11px] leading-snug bg-slate-900/95 border border-white/10 text-slate-200 shadow-lg"
                >
                  {!def || def.status === "idle" || def.status === "loading" ? (
                    <span className="text-slate-400">Loading…</span>
                  ) : def.status === "ready" ? (
                    <span>{def.text}</span>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-rose-300 break-words">
                        error: {def.message}
                      </span>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => fetchDefinition(t.term)}
                        className="self-start px-1.5 py-0.5 rounded text-[10px] font-semibold text-slate-200 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-[color:var(--ac1-mid)] cursor-pointer transition-colors"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
