import type { ReadingMode } from "@/stores/ui-store";

type Props = {
  fileUrl: string;
  mode: ReadingMode;
};

const MODE_FILTER: Record<ReadingMode, string> = {
  light: "none",
  sepia: "sepia(0.5) hue-rotate(-12deg) saturate(1.1) brightness(0.97)",
  dark:  "invert(0.92) hue-rotate(180deg)",
};

const MODE_BG: Record<ReadingMode, string> = {
  light: "#fafafa",
  sepia: "#f4ead4",
  dark:  "#15161b",
};

export function PdfPage({ fileUrl, mode }: Props) {
  return (
    <div
      className="rounded-2xl ring-1 ring-white/5 overflow-hidden"
      style={{
        background: MODE_BG[mode],
        height: "calc(100vh - 100px)",
        transition: "background .25s ease",
      }}
    >
      <iframe
        src={`${fileUrl}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`}
        title="PDF"
        style={{
          width: "100%",
          height: "100%",
          border: 0,
          filter: MODE_FILTER[mode],
          transition: "filter .25s ease",
        }}
      />
    </div>
  );
}
