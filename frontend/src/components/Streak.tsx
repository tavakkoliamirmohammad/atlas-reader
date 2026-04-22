import { useEffect, useState } from "react";
import { Flame } from "lucide-react";
import { u } from "@/lib/api";

type Stats = { streak_days: number; total_papers: number; papers_today: number };

export function Streak() {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    fetch(u("/api/stats"))
      .then((r) => r.json())
      .then(setS)
      .catch(() => setS(null));
  }, []);

  if (!s || (s.streak_days === 0 && s.total_papers === 0)) return null;

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200"
      title={`${s.papers_today} opened today`}
    >
      <Flame className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
      <span><span className="font-medium">{s.streak_days}</span>-day streak</span>
      <span className="text-slate-500">·</span>
      <span><span className="font-medium">{s.total_papers}</span> papers</span>
    </div>
  );
}
