import { useEffect, useState } from "react";
import { Sun, Book, Moon } from "lucide-react";
import { api, type Paper } from "@/lib/api";
import { useUiStore, type ReadingMode } from "@/stores/ui-store";
import { PdfPage } from "./PdfPage";

type Props = { arxivId: string };

const MODES: { id: ReadingMode; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "sepia", label: "Sepia", Icon: Book },
  { id: "dark",  label: "Dark",  Icon: Moon },
];

export function PaperReader({ arxivId }: Props) {
  const [, setPaper] = useState<Paper | null>(null);
  const mode = useUiStore((s) => s.readingMode);
  const setMode = useUiStore((s) => s.setReadingMode);

  useEffect(() => {
    api.paper(arxivId).then(setPaper).catch(() => setPaper(null));
  }, [arxivId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 bg-[rgba(8,8,13,0.5)] backdrop-blur-sm">
        <span className="font-mono text-[11px] text-[color:var(--ac1)]">arXiv:{arxivId}</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] p-1">
          {MODES.map(({ id, label, Icon }) => {
            const active = mode === id;
            return (
              <button
                key={id}
                onClick={() => setMode(id)}
                aria-pressed={active}
                aria-label={`${label} reading mode`}
                className={[
                  "px-2 py-0.5 rounded-full text-[11px] flex items-center gap-1 transition-colors",
                  active
                    ? "text-[color:var(--ac1)] bg-[color:var(--ac1-soft)] border border-[color:var(--ac1-mid)]"
                    : "text-slate-400 border border-transparent hover:text-white",
                ].join(" ")}
              >
                <Icon size={12} /> {label}
              </button>
            );
          })}
        </span>
      </div>
      <div className="flex-1 overflow-hidden p-4">
        <PdfPage fileUrl={api.pdfUrl(arxivId)} mode={mode} />
      </div>
    </div>
  );
}
