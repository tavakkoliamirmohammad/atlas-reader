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
import { useEffect, useRef, useState } from "react";

export function ThemePicker() {
  const paletteId = useUiStore((s) => s.paletteId);
  const setPalette = useUiStore((s) => s.setPalette);
  const customPalette = useUiStore((s) => s.customPalette);
  const setCustomPalette = useUiStore((s) => s.setCustomPalette);

  const [open, setOpen] = useState(false);
  const [draftC1, setDraftC1] = useState<string>(customPalette?.c1 ?? "#22d3ee");
  const [draftC2, setDraftC2] = useState<string>(customPalette?.c2 ?? "#10b981");
  const [draftInk, setDraftInk] = useState<string>(customPalette?.ink ?? INK_LIGHT);

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const customDotRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (paletteId === CUSTOM_PALETTE_ID && customPalette) {
      applyPalette(buildCustomPalette(customPalette.c1, customPalette.c2, customPalette.ink));
    } else {
      const p = getPaletteById(paletteId);
      if (p) applyPalette(p);
    }
  }, [paletteId, customPalette]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        customDotRef.current && !customDotRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function openPopover() {
    setDraftC1(customPalette?.c1 ?? "#22d3ee");
    setDraftC2(customPalette?.c2 ?? "#10b981");
    setDraftInk(customPalette?.ink ?? INK_LIGHT);
    setOpen(true);
  }

  function handleCustomDotClick() {
    if (customPalette) {
      setPalette(CUSTOM_PALETTE_ID);
    } else {
      openPopover();
    }
  }

  function handleCustomDotContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    openPopover();
  }

  function handleSave() {
    setCustomPalette({ c1: draftC1, c2: draftC2, ink: draftInk });
    setPalette(CUSTOM_PALETTE_ID);
    setOpen(false);
  }

  function handleCancel() {
    setOpen(false);
  }

  const isCustomActive = paletteId === CUSTOM_PALETTE_ID && !!customPalette;

  return (
    <div className="relative flex gap-1 px-1.5 py-1 rounded-full border border-white/5 bg-white/[0.03]">
      {PALETTES.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-label={`${p.name} palette`}
          aria-pressed={p.id === paletteId}
          onClick={() => setPalette(p.id)}
          title={p.name}
          className={[
            "w-[18px] h-[18px] rounded-full cursor-pointer transition-transform",
            "shadow-[inset_0_0_0_2px_rgba(0,0,0,0.4)] hover:scale-110",
            p.id === paletteId ? "scale-[1.2] ring-2 ring-[color:var(--ac1)]" : "",
          ].join(" ")}
          style={{ background: `linear-gradient(135deg, ${p.c1}, ${p.c2})` }}
        />
      ))}

      <button
        ref={customDotRef}
        type="button"
        aria-label="Custom palette"
        aria-pressed={isCustomActive}
        onClick={handleCustomDotClick}
        onContextMenu={handleCustomDotContextMenu}
        title={customPalette ? "Custom (right-click to edit)" : "Create custom palette"}
        className={[
          "relative w-[18px] h-[18px] rounded-full cursor-pointer transition-transform",
          "hover:scale-110 flex items-center justify-center",
          customPalette
            ? "shadow-[inset_0_0_0_2px_rgba(0,0,0,0.4)]"
            : "border border-dashed border-white/40 bg-white/[0.04]",
          isCustomActive ? "scale-[1.2] ring-2 ring-[color:var(--ac1)]" : "",
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
        {customPalette && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-black/60 border border-white/30 flex items-center justify-center"
            onClick={(e) => {
              e.stopPropagation();
              openPopover();
            }}
            onContextMenu={(e) => e.preventDefault()}
            style={{ cursor: "pointer" }}
            title="Edit custom palette"
          />
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Custom palette editor"
          className="absolute top-full right-0 mt-2 z-50 w-56 p-3 rounded-lg border border-white/10 bg-[#0b0f17] shadow-2xl flex flex-col gap-3"
        >
          <div className="flex items-center justify-between">
            <label htmlFor="custom-c1" className="text-xs text-white/70">Primary (c1)</label>
            <input
              id="custom-c1"
              type="color"
              value={draftC1}
              onChange={(e) => setDraftC1(e.target.value)}
              className="w-8 h-6 rounded cursor-pointer bg-transparent border border-white/10"
            />
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="custom-c2" className="text-xs text-white/70">Secondary (c2)</label>
            <input
              id="custom-c2"
              type="color"
              value={draftC2}
              onChange={(e) => setDraftC2(e.target.value)}
              className="w-8 h-6 rounded cursor-pointer bg-transparent border border-white/10"
            />
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="custom-ink" className="text-xs text-white/70">Ink</label>
            <select
              id="custom-ink"
              value={draftInk}
              onChange={(e) => setDraftInk(e.target.value)}
              className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-white/90 outline-none"
            >
              <option value={INK_LIGHT}>Light</option>
              <option value={INK_DARK}>Dark</option>
            </select>
          </div>

          <div
            className="h-6 rounded"
            aria-hidden
            style={{ background: `linear-gradient(135deg, ${draftC1}, ${draftC2})` }}
          />

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleCancel}
              className="text-xs px-2 py-1 rounded border border-white/10 text-white/80 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="text-xs px-2 py-1 rounded bg-[color:var(--ac1)] text-black font-medium hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
