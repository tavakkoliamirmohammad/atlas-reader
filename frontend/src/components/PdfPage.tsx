import "@/lib/pdf-worker";
import { Document, Page } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import type { ReadingMode } from "@/stores/ui-store";

type Props = {
  fileUrl: string;
  page: number;
  scale: number;
  mode: ReadingMode;
  onLoadSuccess: (numPages: number) => void;
};

const MODE_BG: Record<ReadingMode, string> = {
  light: "#fafafa",
  sepia: "#f4ead4",
  dark:  "#15161b",
};

const MODE_INK: Record<ReadingMode, string> = {
  light: "#111214",
  sepia: "#2a1f10",
  dark:  "#e9e9ed",
};

export function PdfPage({ fileUrl, page, scale, mode, onLoadSuccess }: Props) {
  const dark = mode === "dark";
  return (
    <div
      className="rounded-2xl shadow-[0_60px_100px_-30px_rgba(0,0,0,0.85)] ring-1 ring-white/5 overflow-hidden animate-fadeUp"
      style={{ background: MODE_BG[mode], color: MODE_INK[mode] }}
    >
      <Document
        file={fileUrl}
        onLoadSuccess={(p) => onLoadSuccess(p.numPages)}
        loading={<div className="p-8 text-center text-slate-500">Loading PDF...</div>}
        error={<div className="p-8 text-center text-rose-400">Failed to load PDF</div>}
      >
        <Page
          pageNumber={page}
          scale={scale}
          renderAnnotationLayer
          renderTextLayer
          canvasBackground={MODE_BG[mode]}
          className={dark ? "[&_canvas]:filter [&_canvas]:invert [&_canvas]:hue-rotate-180" : ""}
        />
      </Document>
    </div>
  );
}
