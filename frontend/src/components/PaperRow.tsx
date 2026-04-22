import { Link, useMatch } from "react-router-dom";
import type { Paper } from "@/lib/api";

type Props = {
  paper: Paper;
  /**
   * True when this row is the keyboard-focused item in the listbox.
   * PaperList controls `activeIndex`; PaperRow just mirrors it visually.
   */
  isActiveRow?: boolean;
  /**
   * Mouse-hover or click bumps activeIndex so keyboard and pointer stay
   * coherent — otherwise tapping Enter would jump somewhere unexpected.
   */
  onFocusRequest?: () => void;
};

/**
 * Small leading dot reflecting read state: empty ring (unread), filled
 * slate dot (read), accent dot (active / currently open). Purely visual;
 * 8px, vertically centered with the title.
 */
function ReadStateDot({
  state,
  active,
}: {
  state: Paper["read_state"];
  active: boolean;
}) {
  const size = 8;
  if (active) {
    return (
      <span
        aria-label="Currently open"
        className="shrink-0 rounded-full"
        style={{
          width: size,
          height: size,
          background: "var(--ac1)",
          boxShadow: "0 0 6px var(--ac1-mid)",
        }}
      />
    );
  }
  if (state === "read") {
    return (
      <span
        aria-label="Read"
        className="shrink-0 rounded-full"
        style={{
          width: size,
          height: size,
          background: "rgb(100 116 139)",
        }}
      />
    );
  }
  // unread or reading — empty ring
  return (
    <span
      aria-label={state === "reading" ? "Reading" : "Unread"}
      className="shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        border: "1px solid rgb(71 85 105)",
        background: "transparent",
      }}
    />
  );
}

export function PaperRow({ paper, isActiveRow, onFocusRequest }: Props) {
  const match = useMatch("/reader/:arxivId");
  const active = match?.params.arxivId === paper.arxiv_id;
  return (
    <Link
      id={`paper-row-${paper.arxiv_id}`}
      data-arxiv-id={paper.arxiv_id}
      to={`/reader/${paper.arxiv_id}`}
      role="option"
      aria-selected={active}
      tabIndex={isActiveRow ? 0 : -1}
      onMouseEnter={onFocusRequest}
      onFocus={onFocusRequest}
      className={[
        "flex items-center gap-2.5 px-3.5 py-2 border-t border-white/5 transition-all duration-200 hover-lift",
        "hover:bg-white/[0.03] hover:translate-x-[2px]",
        active ? "border-l-2 border-l-[color:var(--ac1)] bg-gradient-to-r from-[color:var(--ac1-soft)] to-transparent" : "",
        isActiveRow && !active ? "ring-1 ring-inset ring-white/10 bg-white/[0.02]" : "",
      ].join(" ")}
    >
      <ReadStateDot state={paper.read_state} active={active} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-snug text-slate-100 font-medium line-clamp-2">{paper.title}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          {paper.authors.split(",")[0]}{paper.authors.includes(",") ? " et al." : ""} {"\u00b7"} {paper.categories.split(",")[0]}
        </div>
      </div>
    </Link>
  );
}
