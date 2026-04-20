import { streamSSE, type SSEHandlers } from "./sse";

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

export type ModelChoice = "opus" | "sonnet" | "haiku";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  model?: ModelChoice;
};

export async function streamSummary(
  arxivId: string,
  handlers: SSEHandlers,
  signal?: AbortSignal,
  model?: ModelChoice,
): Promise<void> {
  const url = model
    ? `/api/summarize/${arxivId}?model=${model}`
    : `/api/summarize/${arxivId}`;
  return streamSSE(url, { method: "POST" }, handlers, signal);
}

function _withQuery(base: string, params: Record<string, string | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}

export async function streamAsk(
  arxivId: string,
  question: string,
  history: ChatMessage[],
  handlers: SSEHandlers,
  signal?: AbortSignal,
  model?: ModelChoice,
  threadId?: number,
): Promise<void> {
  const url = _withQuery(`/api/ask/${arxivId}`, {
    model,
    thread_id: threadId !== undefined ? String(threadId) : undefined,
  });
  return streamSSE(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history }),
    },
    handlers,
    signal,
  );
}

export async function fetchConversations(
  arxivId: string,
  threadId?: number,
): Promise<ChatMessage[]> {
  const url = _withQuery(`/api/conversations/${arxivId}`, {
    thread_id: threadId !== undefined ? String(threadId) : undefined,
  });
  const r = await fetch(url);
  const body = await r.json();
  return body.messages.map((m: { role: ChatMessage["role"]; content: string }) => ({
    role: m.role,
    content: m.content,
  }));
}

export type Thread = {
  id: number;
  arxiv_id: string;
  title: string;
  created_at: string | null;
};

export async function fetchThreads(arxivId: string): Promise<Thread[]> {
  const r = await fetch(`/api/threads/${arxivId}`);
  if (!r.ok) throw new Error(`/api/threads/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.threads as Thread[];
}

export async function createThread(arxivId: string, title: string): Promise<Thread> {
  const r = await fetch(`/api/threads/${arxivId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`POST /api/threads/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return { id: body.id, arxiv_id: body.arxiv_id, title: body.title, created_at: null };
}

export type HighlightColor = "yellow" | "coral" | "blue";

export type Highlight = {
  id: number;
  arxiv_id: string;
  quote: string;
  color: HighlightColor;
  page: number | null;
  note: string | null;
  created_at: string | null;
};

export async function fetchHighlights(arxivId: string): Promise<Highlight[]> {
  const r = await fetch(`/api/highlights/${encodeURIComponent(arxivId)}`);
  if (!r.ok) throw new Error(`/api/highlights/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.highlights as Highlight[];
}

export async function createHighlight(
  arxivId: string,
  input: { quote: string; color: HighlightColor; page?: number | null; note?: string | null },
): Promise<number> {
  const r = await fetch(`/api/highlights/${encodeURIComponent(arxivId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`POST /api/highlights/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.id as number;
}

export async function deleteHighlight(id: number): Promise<void> {
  const r = await fetch(`/api/highlights/${id}`, { method: "DELETE" });
  if (!r.ok && r.status !== 204) throw new Error(`DELETE /api/highlights/${id} -> ${r.status}`);
}

export type GlossaryTerm = {
  id: number;
  arxiv_id: string;
  term: string;
  definition: string | null;
  created_at: string | null;
};

export async function fetchGlossary(arxivId: string): Promise<GlossaryTerm[]> {
  const r = await fetch(`/api/glossary/${encodeURIComponent(arxivId)}`);
  if (!r.ok) throw new Error(`/api/glossary/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.terms as GlossaryTerm[];
}

export async function extractGlossary(arxivId: string): Promise<GlossaryTerm[]> {
  const r = await fetch(
    `/api/glossary/${encodeURIComponent(arxivId)}/extract`,
    { method: "POST" },
  );
  if (!r.ok) throw new Error(`POST /api/glossary/${arxivId}/extract -> ${r.status}`);
  const body = await r.json();
  return body.terms as GlossaryTerm[];
}

export async function fetchGlossaryDefinition(
  arxivId: string,
  term: string,
): Promise<string> {
  const r = await fetch(
    `/api/glossary/${encodeURIComponent(arxivId)}/${encodeURIComponent(term)}/definition`,
  );
  if (!r.ok) throw new Error(`definition ${r.status}`);
  const body = await r.json();
  return body.definition as string;
}

export type SearchResult = {
  arxiv_id: string;
  title: string;
  authors: string;
  snippet: string;
  rank: number;
};

export type SearchResponse = { count: number; results: SearchResult[] };

export async function searchPapers(
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`/api/search -> ${r.status}`);
  const body: SearchResponse = await r.json();
  return body.results;
}
