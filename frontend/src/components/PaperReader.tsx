import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useUiStore } from "@/stores/ui-store";
import { PdfPage } from "./PdfPage";
import { PdfToolbar } from "./PdfToolbar";
import { PdfThumbsRail } from "./PdfThumbsRail";

type Props = { arxivId: string };

export function PaperReader({ arxivId }: Props) {
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const mode = useUiStore((s) => s.readingMode);
  const setMode = useUiStore((s) => s.setReadingMode);

  useEffect(() => {
    setPage(1);
    setPageCount(0);
    api.paper(arxivId).catch(() => {});
  }, [arxivId]);

  return (
    <div className="grid h-full" style={{ gridTemplateColumns: "58px 1fr" }}>
      <PdfThumbsRail pageCount={pageCount} current={page} onJump={setPage} />
      <div className="relative flex justify-center items-start p-6 overflow-y-auto">
        <PdfToolbar
          arxivId={arxivId}
          page={page}
          pageCount={pageCount}
          scale={scale}
          mode={mode}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(pageCount || p, p + 1))}
          onZoomIn={() => setScale((s) => Math.min(2, s + 0.1))}
          onZoomOut={() => setScale((s) => Math.max(0.5, s - 0.1))}
          onModeChange={setMode}
        />
        <div className="pt-14 max-w-[720px] w-full">
          <PdfPage
            fileUrl={api.pdfUrl(arxivId)}
            page={page}
            scale={scale}
            mode={mode}
            onLoadSuccess={setPageCount}
          />
        </div>
      </div>
    </div>
  );
}
