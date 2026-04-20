import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Paper } from "@/lib/api";
import { groupPapersByDay } from "@/lib/group-by-day";
import { UrlBar } from "./UrlBar";
import { PaperRow } from "./PaperRow";

export function PaperList() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let res = await api.digest(false);
        if (res.count === 0) {
          res = await api.digest(true);
        }
        if (!cancelled) setPapers(res.papers);
      } catch {
        if (!cancelled) setPapers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const groups = groupPapersByDay(papers);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/5">
        <div className="text-[11px] uppercase tracking-wider text-slate-500">Today {"\u00b7"} {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        <div className="text-[15px] font-semibold mt-0.5 text-slate-100 flex items-center gap-2">
          Daily digest
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-slate-400 font-medium">chrono</span>
        </div>
      </div>
      <UrlBar onSubmit={(id) => navigate(`/reader/${id}`)} />
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="px-4 py-3 text-xs text-slate-500">Loading...</div>}
        {!loading && groups.length === 0 && (
          <div className="px-4 py-3 text-xs text-slate-500">No papers yet. Build the digest from the backend.</div>
        )}
        {groups.map((g) => (
          <div key={g.isoDate}>
            <div className="px-3 pt-2.5 pb-1 text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-600" />
              {g.dateLabel} ({g.count})
            </div>
            {g.papers.map((p) => <PaperRow key={p.arxiv_id} paper={p} />)}
          </div>
        ))}
      </div>
    </div>
  );
}
