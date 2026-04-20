export type Palette = {
  id: string;
  name: string;
  c1: string;   // primary accent hex
  c2: string;   // secondary accent hex
  ink: string;  // foreground ink for grad pills
};

export const PALETTES: Palette[] = [
  { id: "cyan-emerald",  name: "Cyan / emerald",  c1: "#22d3ee", c2: "#10b981", ink: "#06121a" },
  { id: "emerald-teal",  name: "Emerald / teal",  c1: "#10b981", c2: "#14b8a6", ink: "#06121a" },
  { id: "sky-indigo",    name: "Sky / indigo",    c1: "#38bdf8", c2: "#6366f1", ink: "#06121a" },
  { id: "amber-orange",  name: "Amber / orange",  c1: "#fbbf24", c2: "#f97316", ink: "#0b0f17" },
  { id: "lime-emerald",  name: "Lime / emerald",  c1: "#a3e635", c2: "#10b981", ink: "#0b0f17" },
  { id: "mono-arctic",   name: "Mono / arctic",   c1: "#e2e8f0", c2: "#94a3b8", ink: "#0b0f17" },
];

export const DEFAULT_PALETTE_ID = "cyan-emerald";

export function getPaletteById(id: string): Palette | undefined {
  return PALETTES.find((p) => p.id === id);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgba([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function applyPalette(p: Palette): void {
  const root = document.documentElement;
  const c1 = hexToRgb(p.c1);
  const c2 = hexToRgb(p.c2);
  root.style.setProperty("--ac1", p.c1);
  root.style.setProperty("--ac2", p.c2);
  root.style.setProperty("--ac1-rgb", `${c1[0]} ${c1[1]} ${c1[2]}`);
  root.style.setProperty("--ac2-rgb", `${c2[0]} ${c2[1]} ${c2[2]}`);
  root.style.setProperty("--ac1-soft",   rgba(c1, 0.10));
  root.style.setProperty("--ac1-mid",    rgba(c1, 0.35));
  root.style.setProperty("--ac1-strong", rgba(c1, 0.55));
  root.style.setProperty("--ac2-soft",   rgba(c2, 0.10));
  root.style.setProperty("--user-ink",   p.ink);
  root.style.setProperty("--user-grad",  `linear-gradient(135deg, ${p.c1}, ${p.c2})`);
}
