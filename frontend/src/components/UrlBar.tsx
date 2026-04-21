import { useEffect, useRef, useState } from "react";
import { Plus, Upload } from "lucide-react";
import { parseArxivId } from "@/lib/arxiv-id";
import { importPdfUpload, importPdfUrl } from "@/lib/api";

type Props = { onSubmit: (arxivId: string) => void };

// How long the red-tinted border flashes after a failed submit. Error text
// stays visible until the user edits the field, but the ring is intentionally
// brief so it reads as a nudge rather than a lingering alarm.
const ERROR_FLASH_MS = 1500;

function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

export function UrlBar({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const flashTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  function reportError(msg: string) {
    setError(msg);
    triggerFlash();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    const trimmed = value.trim();
    if (!trimmed) return;

    // First, try the arXiv parser — an arXiv URL or a bare arXiv ID takes
    // priority over the generic-URL path, so users don't accidentally
    // re-download a paper we already know how to fetch natively.
    const arxivId = parseArxivId(trimmed);
    if (arxivId) {
      onSubmit(arxivId);
      setValue("");
      setError(null);
      setFlash(false);
      return;
    }

    // Generic PDF URL (not arXiv).
    if (looksLikeUrl(trimmed)) {
      setBusy(true);
      try {
        const id = await importPdfUrl(trimmed);
        onSubmit(id);
        setValue("");
        setError(null);
        setFlash(false);
      } catch (err) {
        reportError((err as Error).message || "Import failed");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (trimmed.startsWith("10.")) {
      reportError("That looks like a DOI — paste a direct PDF URL instead");
    } else {
      reportError("Paste an arXiv URL, arXiv ID, or a direct PDF URL");
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";  // allow re-picking the same file later
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      reportError("Only .pdf files are accepted");
      return;
    }
    setBusy(true);
    try {
      const id = await importPdfUpload(file);
      onSubmit(id);
      setError(null);
      setFlash(false);
    } catch (err) {
      reportError((err as Error).message || "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-3 mt-2 mb-1 flex flex-col gap-1">
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
          placeholder="Paste arXiv URL, paper ID, or direct PDF URL..."
          aria-invalid={error !== null}
          disabled={busy}
          className="flex-1 bg-transparent border-0 outline-none text-xs text-slate-300 placeholder:text-slate-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy}
          className="px-2 py-0.5 rounded-md text-xs font-semibold cursor-pointer disabled:opacity-50"
          style={{ background: "var(--user-grad)", color: "var(--user-ink)" }}
        >
          {busy ? "…" : "Open"}
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label="Upload a local PDF"
          className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-200 cursor-pointer disabled:opacity-50"
        >
          <Upload size={10} />
          Upload PDF
        </button>
        {error && (
          <div role="alert" className="text-[10px] text-rose-400">
            {error}
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        onChange={onFilePicked}
        className="hidden"
      />
    </form>
  );
}
