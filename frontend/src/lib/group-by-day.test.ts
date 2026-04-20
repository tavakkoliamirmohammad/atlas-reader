import { describe, it, expect } from "vitest";
import { groupPapersByDay } from "./group-by-day";
import type { Paper } from "./api";

const mk = (id: string, published: string): Paper => ({
  arxiv_id: id, title: id, authors: "", abstract: "", categories: "",
  published, pdf_path: null, ai_tier: null, ai_score: null, read_state: "unread",
});

describe("groupPapersByDay", () => {
  it("groups papers by ISO date and orders newest day first", () => {
    const papers = [
      mk("a", "2026-04-19T08:00:00Z"),
      mk("b", "2026-04-18T11:00:00Z"),
      mk("c", "2026-04-19T22:00:00Z"),
      mk("d", "2026-04-17T05:00:00Z"),
    ];
    const groups = groupPapersByDay(papers);
    expect(groups.map((g) => g.dateLabel)).toEqual(["Apr 19", "Apr 18", "Apr 17"]);
    expect(groups[0].papers.map((p) => p.arxiv_id)).toEqual(["c", "a"]);
    expect(groups[1].papers.map((p) => p.arxiv_id)).toEqual(["b"]);
    expect(groups[2].papers.map((p) => p.arxiv_id)).toEqual(["d"]);
  });

  it("returns an empty list for no papers", () => {
    expect(groupPapersByDay([])).toEqual([]);
  });

  it("each group exposes a count and an isoDate", () => {
    const papers = [mk("a", "2026-04-19T08:00:00Z"), mk("b", "2026-04-19T22:00:00Z")];
    const [g] = groupPapersByDay(papers);
    expect(g.count).toBe(2);
    expect(g.isoDate).toBe("2026-04-19");
  });
});
