import { Link, useParams } from "react-router-dom";
import type { Paper } from "@/lib/api";

type Props = { paper: Paper };

export function PaperRow({ paper }: Props) {
  const { arxivId } = useParams<{ arxivId: string }>();
  const active = arxivId === paper.arxiv_id;
  return (
    <Link
      to={`/reader/${paper.arxiv_id}`}
      className={[
        "block px-3.5 py-2 border-t border-white/5 transition-all duration-200 hover-lift",
        "hover:bg-white/[0.03] hover:translate-x-[2px]",
        active ? "border-l-2 border-l-[color:var(--ac1)] bg-gradient-to-r from-[color:var(--ac1-soft)] to-transparent" : "",
      ].join(" ")}
    >
      <div className="text-[13px] leading-snug text-slate-100 font-medium line-clamp-2">{paper.title}</div>
      <div className="text-[11px] text-slate-500 mt-0.5">
        {paper.authors.split(",")[0]}{paper.authors.includes(",") ? " et al." : ""} {"\u00b7"} {paper.categories.split(",")[0]}
      </div>
    </Link>
  );
}
