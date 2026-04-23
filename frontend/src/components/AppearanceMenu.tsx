import { useEffect, useRef, useState } from "react";
import { Palette, Moon, Sun } from "lucide-react";
import { useUiStore } from "@/stores/ui-store";
import {
  PALETTES,
  applyPalette,
  getPaletteById,
  buildCustomPalette,
  CUSTOM_PALETTE_ID,
  INK_LIGHT,
  INK_DARK,
} from "@/lib/theme";

/**
 * Single entry point for visual preferences — consolidates what used to be
 * three separate top-bar widgets (seven-swatch ThemePicker strip +
 * AppModeToggle sun/moon) into one icon + popover. Keeps the top bar quiet.
 */
export function AppearanceMenu() {
  const paletteId = useUiStore((s) => s.paletteId);
  const setPalette = useUiStore((s) => s.setPalette);
  const customPalette = useUiStore((s) => s.customPalette);
  const setCustomPalette = useUiStore((s) => s.setCustomPalette);
  const appMode = useUiStore((s) => s.appMode);
  const setAppMode = useUiStore((s) => s.setAppMode);

  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [draftC1, setDraftC1] = useState(customPalette?.c1 ?? "#22d3ee");
  const [draftC2, setDraftC2] = useState(customPalette?.c2 ?? "#10b981");
  const [draftInk, setDraftInk] = useState(customPalette?.ink ?? INK_LIGHT);

  const rootRef = useRef<HTMLDivElement | null>(null);

  // Keep the document's active palette in sync (moved here from ThemePicker).
  useEffect(() => {
    if (paletteId === CUSTOM_PALETTE_ID && customPalette) {
      applyPalette(buildCustomPalette(customPalette.c1, customPalette.c2, customPalette.ink));
    } else {
      const p = getPaletteById(paletteId);
      if (p) applyPalette(p);
    }
  }, [paletteId, customPalette]);

  // Click outside the whole menu closes it.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function openCustomEditor() {
    setDraftC1(customPalette?.c1 ?? "#22d3ee");
    setDraftC2(customPalette?.c2 ?? "#10b981");
    setDraftInk(customPalette?.ink ?? INK_LIGHT);
    setCustomOpen(true);
  }

  function saveCustom() {
    setCustomPalette({ c1: draftC1, c2: draftC2, ink: draftInk });
    setPalette(CUSTOM_PALETTE_ID);
    setCustomOpen(false);
  }

  const isCustomActive = paletteId === CUSTOM_PALETTE_ID && !!customPalette;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Appearance"
        title="Appearance"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/[0.04] border border-white/5 text-slate-300 hover:text-slate-100 hover:border-[color:var(--ac1-mid)] transition-colors cursor-pointer"
      >
        <Palette size={13} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Appearance"
          className="absolute top-full right-0 mt-2 z-50 w-64 p-3 rounded-xl shadow-2xl flex flex-col gap-3 backdrop-blur-md"
          style={{
            background: "var(--surface-overlay)",
            border: "1px solid var(--surface-overlay-border)",
            color: "var(--surface-overlay-text)",
          }}
        >
          {/* Theme mode — segmented Light / Dark */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Mode</div>
            <div
              role="radiogroup"
              aria-label="App theme mode"
              className="inline-flex w-full rounded-full border border-white/10 bg-white/[0.03] p-0.5 text-xs"
            >
              {([
                ["dark",  "Dark",  <Moon size={12} key="m" />],
                ["light", "Light", <Sun size={12} key="s" />],
              ] as const).map(([value, label, icon]) => {
                const active = appMode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setAppMode(value)}
                    className={[
                      "flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-full transition-colors cursor-pointer",
                      active
                        ? "bg-white/10 text-slate-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                  >
                    {icon} {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Palette swatches */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Accent</div>
            <div className="flex flex-wrap gap-1.5">
              {PALETTES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-label={`${p.name} palette`}
                  aria-pressed={p.id === paletteId}
                  onClick={() => setPalette(p.id)}
                  title={p.name}
                  className={[
                    "w-[20px] h-[20px] rounded-full cursor-pointer transition-transform",
                    "shadow-[inset_0_0_0_2px_rgba(0,0,0,0.4)] hover:scale-110",
                    p.id === paletteId ? "ring-2 ring-[color:var(--ac1)]" : "",
                  ].join(" ")}
                  style={{ background: `linear-gradient(135deg, ${p.c1}, ${p.c2})` }}
                />
              ))}
              <button
                type="button"
                aria-label="Custom palette"
                aria-pressed={isCustomActive}
                onClick={() => {
                  if (customPalette && !isCustomActive) setPalette(CUSTOM_PALETTE_ID);
                  else openCustomEditor();
                }}
                title={customPalette ? "Custom — click to edit" : "Create custom palette"}
                className={[
                  "w-[20px] h-[20px] rounded-full cursor-pointer transition-transform hover:scale-110 flex items-center justify-center",
                  customPalette
                    ? "shadow-[inset_0_0_0_2px_rgba(0,0,0,0.4)]"
                    : "border border-dashed border-white/40 bg-white/[0.04]",
                  isCustomActive ? "ring-2 ring-[color:var(--ac1)]" : "",
                ].join(" ")}
                style={
                  customPalette
                    ? { background: `linear-gradient(135deg, ${customPalette.c1}, ${customPalette.c2})` }
                    : undefined
                }
              >
                {!customPalette && (
                  <span className="text-white/70 text-[12px] leading-none font-semibold select-none">+</span>
                )}
              </button>
            </div>
          </div>

          {/* Custom palette editor — inline, opens when user clicks the + or edits existing */}
          {customOpen && (
            <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-400">Primary</label>
                <input type="color" value={draftC1} onChange={(e) => setDraftC1(e.target.value)}
                  className="w-8 h-6 rounded cursor-pointer bg-transparent border border-white/10" />
              </div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-400">Secondary</label>
                <input type="color" value={draftC2} onChange={(e) => setDraftC2(e.target.value)}
                  className="w-8 h-6 rounded cursor-pointer bg-transparent border border-white/10" />
              </div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-400">Ink</label>
                <select value={draftInk} onChange={(e) => setDraftInk(e.target.value)}
                  className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-slate-200 outline-none">
                  <option value={INK_LIGHT}>Light</option>
                  <option value={INK_DARK}>Dark</option>
                </select>
              </div>
              <div className="h-6 rounded" style={{ background: `linear-gradient(135deg, ${draftC1}, ${draftC2})` }} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setCustomOpen(false)}
                  className="text-xs px-2 py-1 rounded border border-white/10 text-slate-300 hover:bg-white/5 cursor-pointer">
                  Cancel
                </button>
                <button type="button" onClick={saveCustom}
                  className="text-xs px-2 py-1 rounded bg-[color:var(--ac1)] text-[color:var(--user-ink)] font-medium hover:opacity-90 cursor-pointer">
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
