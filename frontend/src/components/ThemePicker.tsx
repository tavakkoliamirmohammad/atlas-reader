import { useUiStore } from "@/stores/ui-store";
import { PALETTES, applyPalette, getPaletteById } from "@/lib/theme";
import { useEffect } from "react";

export function ThemePicker() {
  const paletteId = useUiStore((s) => s.paletteId);
  const setPalette = useUiStore((s) => s.setPalette);

  useEffect(() => {
    const p = getPaletteById(paletteId);
    if (p) applyPalette(p);
  }, [paletteId]);

  return (
    <div className="flex gap-1 px-1.5 py-1 rounded-full border border-white/5 bg-white/[0.03]">
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
    </div>
  );
}
