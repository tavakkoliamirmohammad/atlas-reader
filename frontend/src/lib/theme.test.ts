import { describe, it, expect, beforeEach } from "vitest";
import { PALETTES, applyPalette, getPaletteById, DEFAULT_PALETTE_ID } from "./theme";

describe("theme palettes", () => {
  it("ships exactly 6 palettes", () => {
    expect(PALETTES).toHaveLength(6);
  });

  it("has the cyan/emerald palette as default", () => {
    expect(DEFAULT_PALETTE_ID).toBe("cyan-emerald");
    const p = getPaletteById(DEFAULT_PALETTE_ID);
    expect(p?.c1).toBe("#22d3ee");
    expect(p?.c2).toBe("#10b981");
  });

  it("includes the named palettes from the spec", () => {
    const ids = PALETTES.map((p) => p.id).sort();
    expect(ids).toEqual([
      "amber-orange",
      "cyan-emerald",
      "emerald-teal",
      "lime-emerald",
      "mono-arctic",
      "sky-indigo",
    ]);
  });
});

describe("applyPalette", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("sets all CSS custom properties on :root", () => {
    applyPalette(getPaletteById("sky-indigo")!);
    const styles = document.documentElement.style;
    expect(styles.getPropertyValue("--ac1").trim()).toBe("#38bdf8");
    expect(styles.getPropertyValue("--ac2").trim()).toBe("#6366f1");
    expect(styles.getPropertyValue("--ac1-rgb").trim()).toBe("56 189 248");
    expect(styles.getPropertyValue("--ac1-soft").trim()).toMatch(/^rgba\(56,\s*189,\s*248,\s*0\.1\)$/);
    expect(styles.getPropertyValue("--ac1-mid").trim()).toMatch(/^rgba\(56,\s*189,\s*248,\s*0\.35\)$/);
    expect(styles.getPropertyValue("--ac1-strong").trim()).toMatch(/^rgba\(56,\s*189,\s*248,\s*0\.55\)$/);
    expect(styles.getPropertyValue("--user-ink").trim()).toBe("#06121a");
  });
});
