import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { parseArxivId } from "@/lib/arxiv-id";

type Props = { onSubmit: (arxivId: string) => void };

// How long the red-tinted border flashes after a failed submit. Error text
// stays visible until the user edits the field, but the ring is intentionally
// brief so it reads as a nudge rather than a lingering alarm.
const ERROR_FLASH_MS = 1500;

export function UrlBar({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  function triggerFlash() {
    setFlash(true);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setFlash(false);
      flashTimerRef.current = null;
    }, ERROR_FLASH_MS);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const id = parseArxivId(value);
    if (id) {
      onSubmit(id);
      setValue("");
      setError(null);
      setFlash(false);
      return;
    }
    // Distinguish a pasted DOI from random garbage — the former is a very
    // common copy-paste slip from journal pages.
    const trimmed = value.trim();
    if (trimmed.startsWith("10.")) {
      setError("That looks like a DOI — paste the arXiv URL instead");
    } else {
      setError("Unrecognized arXiv URL or ID");
    }
    triggerFlash();
  }

  return (
    <form
      onSubmit={submit}
      className="mx-3 mt-2 mb-1 flex flex-col gap-1"
    >
      <div
        className={[
          "flex items-center gap-2 px-2.5 py-2 rounded-[10px] bg-white/[0.04] border transition-colors",
          flash ? "border-rose-400/70" : "border-white/5",
        ].join(" ")}
      >
        <Plus size={14} className="text-[color:var(--ac1)]" />
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
            if (flash) setFlash(false);
          }}
          placeholder="Paste arXiv URL or paper ID..."
          aria-invalid={error !== null}
          className="flex-1 bg-transparent border-0 outline-none text-xs text-slate-300 placeholder:text-slate-500"
        />
        <button
          type="submit"
          className="px-2 py-0.5 rounded-md text-xs font-semibold cursor-pointer"
          style={{ background: "var(--user-grad)", color: "var(--user-ink)" }}
        >
          Open
        </button>
      </div>
      {error && (
        <div role="alert" className="text-[10px] text-rose-400 px-1">
          {error}
        </div>
      )}
    </form>
  );
}
