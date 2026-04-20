export type Paper = {
  arxiv_id: string;
  title: string;
  authors: string;
  abstract: string;
  categories: string;
  published: string;
  pdf_path: string | null;
  ai_tier: number | null;
  ai_score: number | null;
  read_state: "unread" | "reading" | "read";
};

export type HealthResponse = { ai: boolean; papers_today: number };
export type DigestResponse = { count: number; papers: Paper[] };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health:  () => getJson<HealthResponse>("/api/health"),
  digest:  (build = false) => getJson<DigestResponse>(`/api/digest${build ? "?build=true" : ""}`),
  paper:   (id: string) => getJson<Paper>(`/api/papers/${encodeURIComponent(id)}`),
  pdfUrl:  (id: string) => `/api/pdf/${encodeURIComponent(id)}`,
};
