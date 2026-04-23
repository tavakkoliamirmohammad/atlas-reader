import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, RotateCw } from "lucide-react";
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

// Popover geometry — nudges and viewport margins stay in one place so the
// chip and the floating tooltip agree.
const TOOLTIP_W = 264;
const TOOLTIP_EST_H = 72;
const VIEWPORT_PAD = 8;
const TRIGGER_GAP = 6;
const HOVER_OPEN_DELAY = 140;
const HOVER_CLOSE_DELAY = 120;

type Placement = "bottom" | "top";
type Coords = { x: number; y: number; placement: Placement };

function measure(trigger: HTMLElement): Coords {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceBelow = vh - rect.bottom;
  const placement: Placement =
    spaceBelow >= TOOLTIP_EST_H + TRIGGER_GAP + VIEWPORT_PAD ? "bottom" : "top";
  const y =
    placement === "bottom"
      ? rect.bottom + TRIGGER_GAP
      : rect.top - TRIGGER_GAP;
  let x = rect.left;
  if (x + TOOLTIP_W > vw - VIEWPORT_PAD) x = vw - TOOLTIP_W - VIEWPORT_PAD;
  if (x < VIEWPORT_PAD) x = VIEWPORT_PAD;
  return { x, y, placement };
}

function TermChip({
  term,
  def,
  onRequestDef,
}: {
  term: GlossaryTerm;
  def: DefState | undefined;
  onRequestDef: () => void;
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const open = pinned || hovering;

  const clearTimers = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleOpen = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (hovering || openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setHovering(true);
      if (!def || def.status === "idle") onRequestDef();
    }, HOVER_OPEN_DELAY);
  };

  const scheduleClose = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setHovering(false);
    }, HOVER_CLOSE_DELAY);
  };

  useEffect(() => () => clearTimers(), []);

  // Position the popover. Re-measure on open, on scroll (any ancestor, so we
  // use capture), and on window resize — keeps the tooltip glued to the chip.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      if (!triggerRef.current) return;
      setCoords(measure(triggerRef.current));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // When pinned, Esc closes and any click outside closes.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPinned(false);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      const tip = document.getElementById(`glossary-tip-${term.id}`);
      if (tip?.contains(target)) return;
      setPinned(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [pinned, term.id]);

  const showTip = open && coords !== null;

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        role="button"
        aria-describedby={showTip ? `glossary-tip-${term.id}` : undefined}
        aria-expanded={pinned}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={() => {
          if (!pinned) scheduleClose();
        }}
        onClick={(e) => {
          e.stopPropagation();
          clearTimers();
          setPinned((v) => !v);
          setHovering(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            clearTimers();
            setPinned((v) => !v);
            setHovering(false);
          }
        }}
        className={[
          "inline-block select-none px-2 py-0.5 rounded-md text-[11px] cursor-pointer",
          "border border-[color:var(--ac1-mid)] bg-[color:var(--ac1-soft)] text-slate-200",
          "transition-[transform,box-shadow,border-color] duration-150",
          "hover:-translate-y-[1px] hover:shadow-[0_3px_8px_-4px_var(--ac1-mid)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ac1-mid)]",
          pinned
            ? "border-[color:var(--ac1)] shadow-[0_0_0_1px_var(--ac1)] bg-[color:var(--ac1-soft)]"
            : "",
        ].join(" ")}
      >
        {term.term}
      </span>
      {showTip &&
        createPortal(
          <div
            id={`glossary-tip-${term.id}`}
            role="tooltip"
            onMouseEnter={scheduleOpen}
            onMouseLeave={scheduleClose}
            style={{
              position: "fixed",
              left: coords.x,
              ...(coords.placement === "bottom"
                ? { top: coords.y }
                : { bottom: window.innerHeight - coords.y }),
              width: TOOLTIP_W,
              zIndex: 1000,
            }}
            className={[
              "px-3 py-2 rounded-lg text-[11.5px] leading-snug",
              "bg-slate-900/95 backdrop-blur-sm",
              "border border-white/10 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)]",
              "text-slate-200",
              "fade-up",
            ].join(" ")}
          >
            {!def || def.status === "idle" || def.status === "loading" ? (
              <div className="flex items-center gap-2 text-slate-400">
                <span
                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
                  aria-hidden
                />
                Looking up…
              </div>
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
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestDef();
                  }}
                  className="self-start px-1.5 py-0.5 rounded text-[10px] font-semibold text-slate-200 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-[color:var(--ac1-mid)] cursor-pointer transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
            {pinned && (
              <div className="mt-2 pt-1.5 border-t border-white/5 text-[9.5px] uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span>Pinned</span>
                <kbd className="rounded bg-white/5 px-1 py-px font-mono text-[9px] normal-case">
                  Esc
                </kbd>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function Glossary({ arxivId }: Props) {
  const [open, setOpen] = useState(true);
  const [terms, setTerms] = useState<GlossaryTerm[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [defs, setDefs] = useState<Record<string, DefState>>({});

  // Reset state and reload on paper switch.
  useEffect(() => {
    setTerms(null);
    setDefs({});
    let cancelled = false;
    fetchGlossary(arxivId)
      .then((rows) => {
        if (cancelled) return;
        setTerms(rows);
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
    } catch {
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

  const count = terms?.length ?? 0;
  const showBuildButton = terms !== null && count === 0;

  return (
    <div className="border-b border-white/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown size={14} className="text-slate-400" />
          ) : (
            <ChevronRight size={14} className="text-slate-400" />
          )}
          <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
            Glossary
          </span>
          {count > 0 && (
            <span className="text-[10px] text-slate-400 font-mono">{count}</span>
          )}
        </span>
        {showBuildButton && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Build glossary"
            aria-disabled={extracting}
            onClick={(e) => {
              e.stopPropagation();
              if (!extracting) build();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (!extracting) build();
              }
            }}
            className="px-2 py-0.5 rounded-md text-[10px] font-semibold cursor-pointer aria-disabled:opacity-50 bg-white/[0.04] border border-white/10 text-slate-300 hover:bg-white/[0.08] hover:border-[color:var(--ac1-mid)] transition-colors"
          >
            {extracting ? "Extracting…" : "Build glossary"}
          </span>
        )}
        {count > 0 && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Rebuild glossary"
            aria-disabled={extracting}
            title="Rebuild glossary"
            onClick={(e) => {
              e.stopPropagation();
              if (!extracting) build();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (!extracting) build();
              }
            }}
            className="w-6 h-6 inline-flex items-center justify-center rounded-md border border-white/10 text-slate-400 hover:text-white hover:border-white/20 cursor-pointer aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
          >
            <RotateCw size={11} className={extracting ? "animate-spin" : undefined} />
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3">
          {terms === null ? (
            <div className="text-[11px] text-slate-400 px-1 py-1 leading-relaxed">
              Loading…
            </div>
          ) : count === 0 ? (
            <div className="text-[11px] text-slate-400 px-1 py-1 leading-relaxed">
              No terms yet — click Build glossary to extract.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {terms.map((t) => (
                <TermChip
                  key={t.id}
                  term={t}
                  def={defs[t.term]}
                  onRequestDef={() => fetchDefinition(t.term)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
