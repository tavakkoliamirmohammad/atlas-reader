import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Paper } from "@/lib/api";
import { groupPapersByDay } from "@/lib/group-by-day";
import { UrlBar } from "./UrlBar";
import { PaperRow } from "./PaperRow";

const TIER_META = {
  A: { label: "Must read",     icon: "🔥", color: "#fb7185" },
  B: { label: "Worth knowing", icon: "⭐", color: "#fbbf24" },
  C: { label: "Peripheral",    icon: "📄", color: "#94a3b8" },
} as const;

type TierKey = keyof typeof TIER_META;

function tierFor(p: Paper): TierKey | null {
  if (p.ai_tier == null) return null;
  if (p.ai_tier >= 4) return "A";
  if (p.ai_tier >= 2) return "B";
  return "C";
}

function groupByTier(papers: Paper[]): Record<TierKey, Paper[]> {
  const out: Record<TierKey, Paper[]> = { A: [], B: [], C: [] };
  for (const p of papers) {
    const t = tierFor(p);
    if (t) out[t].push(p);
  }
  return out;
}

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

  const hasTiers = papers.some((p) => p.ai_tier != null);
  const tierGroups = hasTiers ? groupByTier(papers) : null;
  const dayGroups = hasTiers ? null : groupPapersByDay(papers);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/5">
        <div className="text-[11px] uppercase tracking-wider text-slate-500">Today {"\u00b7"} {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        <div className="text-[15px] font-semibold mt-0.5 text-slate-100 flex items-center gap-2">
          Daily digest
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-slate-400 font-medium">
            {hasTiers ? "AI-ranked" : "Newest first"}
          </span>
        </div>
      </div>
      <UrlBar onSubmit={(id) => navigate(`/reader/${id}`)} />
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="px-4 py-3 text-xs text-slate-500">Loading...</div>}
        {!loading && papers.length === 0 && (
          <div className="px-4 py-3 text-xs text-slate-500">No papers yet. Build the digest from the backend.</div>
        )}
        {tierGroups && (["A", "B", "C"] as TierKey[]).map((tier) => {
          const items = tierGroups[tier];
          if (items.length === 0) return null;
          const meta = TIER_META[tier];
          return (
            <div key={tier}>
              <div
                className="px-3 pt-2.5 pb-1 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5"
                style={{ color: meta.color }}
              >
                <span aria-hidden>{meta.icon}</span>
                {meta.label} ({items.length})
              </div>
              {items.map((p) => <PaperRow key={p.arxiv_id} paper={p} />)}
            </div>
          );
        })}
        {dayGroups && dayGroups.map((g) => (
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
