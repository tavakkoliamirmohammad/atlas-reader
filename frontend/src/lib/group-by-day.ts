import type { Paper } from "./api";

export type DayGroup = {
  isoDate: string;
  dateLabel: string;
  papers: Paper[];
  count: number;
};

const MONTH = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function isoDay(s: string): string { return s.slice(0, 10); }

function label(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTH[m - 1]} ${d}`;
}

export function groupPapersByDay(papers: Paper[]): DayGroup[] {
  const buckets = new Map<string, Paper[]>();
  for (const p of papers) {
    const day = isoDay(p.published);
    const arr = buckets.get(day) ?? [];
    arr.push(p);
    buckets.set(day, arr);
  }
  const groups: DayGroup[] = Array.from(buckets.entries()).map(([iso, ps]) => ({
    isoDate: iso,
    dateLabel: label(iso),
    papers: [...ps].sort((a, b) => b.published.localeCompare(a.published)),
    count: ps.length,
  }));
  groups.sort((a, b) => b.isoDate.localeCompare(a.isoDate));
  return groups;
}
