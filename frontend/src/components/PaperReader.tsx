import { useEffect, useState } from "react";
import { api, type Paper } from "@/lib/api";
import { useUiStore } from "@/stores/ui-store";
import { PdfPage } from "./PdfPage";

type Props = { arxivId: string };

export function PaperReader({ arxivId }: Props) {
  const [, setPaper] = useState<Paper | null>(null);
  const mode = useUiStore((s) => s.readingMode);

  useEffect(() => {
    api.paper(arxivId).then(setPaper).catch(() => setPaper(null));
  }, [arxivId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden p-4">
        <PdfPage fileUrl={api.pdfUrl(arxivId)} mode={mode} arxivId={arxivId} />
      </div>
    </div>
  );
}
