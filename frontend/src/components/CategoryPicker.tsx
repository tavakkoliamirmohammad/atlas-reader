import { useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";

type Props = {
  selected: string[];
  onChange: (cats: string[]) => void;
};

const CURATED: { code: string; label: string }[] = [
  { code: "cs.PL",   label: "Programming Languages" },
  { code: "cs.AR",   label: "Hardware Architecture" },
  { code: "cs.DC",   label: "Distributed Computing" },
  { code: "cs.PF",   label: "Performance" },
  { code: "cs.LG",   label: "Machine Learning" },
  { code: "cs.AI",   label: "AI" },
  { code: "cs.CL",   label: "NLP" },
  { code: "cs.CV",   label: "Computer Vision" },
  { code: "cs.SE",   label: "Software Engineering" },
  { code: "cs.OS",   label: "Operating Systems" },
  { code: "cs.DS",   label: "Data Structures" },
  { code: "cs.CR",   label: "Cryptography" },
  { code: "cs.HC",   label: "Human-Computer Interaction" },
  { code: "cs.RO",   label: "Robotics" },
  { code: "cs.NE",   label: "Neural Computing" },
  { code: "math.OC", label: "Optimization & Control" },
  { code: "stat.ML", label: "Statistics — ML" },
];

// Mirrors the backend's _ARXIV_CAT regex so we surface bad input before sending.
const VALID_CAT = /^[a-z][a-z\-]*(\.[A-Z]{2})?$/;

export function CategoryPicker({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selectedSet = new Set(selected);

  function toggle(code: string) {
    if (selectedSet.has(code)) {
      onChange(selected.filter((c) => c !== code));
    } else {
      onChange([...selected, code]);
    }
  }

  function addCustom() {
    const trimmed = custom.trim();
    if (!trimmed) return;
    if (!VALID_CAT.test(trimmed)) {
      setError("Use codes like cs.PL or math.OC");
      return;
    }
    if (!selectedSet.has(trimmed)) onChange([...selected, trimmed]);
    setCustom("");
    setError(null);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Pick arXiv categories"
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
      >
        <Layers size={11} aria-hidden />
        <span>{selected.length}</span>
        <span>cat{selected.length === 1 ? "" : "s"}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select arXiv categories"
          className="absolute top-full right-0 mt-2 w-[240px] rounded-xl backdrop-blur-md shadow-2xl z-30 overflow-hidden"
          style={{
            background: "var(--surface-overlay)",
            border: "1px solid var(--surface-overlay-border)",
            color: "var(--surface-overlay-text)",
          }}
        >
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-slate-400 border-b border-white/10">
            arXiv categories
          </div>
          <ul className="max-h-[260px] overflow-y-auto py-1">
            {CURATED.map(({ code, label }) => {
              const checked = selectedSet.has(code);
              return (
                <li key={code}>
                  <button
                    type="button"
                    onClick={() => toggle(code)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left text-[12px] hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={`inline-block h-3 w-3 rounded-sm border ${checked ? "bg-[color:var(--ac1)] border-[color:var(--ac1)]" : "border-white/20"}`}
                      />
                      <span className="font-mono text-[11px]">{code}</span>
                    </span>
                    <span className="text-[10px] text-slate-400 truncate">{label}</span>
                  </button>
                </li>
              );
            })}
            {selected
              .filter((c) => !CURATED.some((x) => x.code === c))
              .map((code) => (
                <li key={code}>
                  <button
                    type="button"
                    onClick={() => toggle(code)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left text-[12px] hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 rounded-sm bg-[color:var(--ac1)] border border-[color:var(--ac1)]"
                      />
                      <span className="font-mono text-[11px]">{code}</span>
                    </span>
                    <span className="text-[10px] text-slate-400 italic">custom</span>
                  </button>
                </li>
              ))}
          </ul>
          <div className="border-t border-white/10 px-3 py-2 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                placeholder="Add code (e.g. q-bio.NC)"
                aria-label="Custom arXiv category"
                className="flex-1 bg-white/[0.04] border border-white/5 rounded px-2 py-1 text-[11px] font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[color:var(--ac1-mid)]"
              />
              <button
                type="button"
                onClick={addCustom}
                disabled={!custom.trim()}
                className="px-2 py-1 rounded text-[11px] bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 disabled:opacity-40 cursor-pointer"
              >
                Add
              </button>
            </div>
            {error && (
              <div role="alert" className="text-[10px] text-rose-300">
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
