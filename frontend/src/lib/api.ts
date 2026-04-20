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

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export type ModelChoice = "opus" | "sonnet" | "haiku";

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

export async function streamAsk(
  arxivId: string,
  question: string,
  history: ChatMessage[],
  handlers: SSEHandlers,
  signal?: AbortSignal,
  model?: ModelChoice,
): Promise<void> {
  const url = model
    ? `/api/ask/${arxivId}?model=${model}`
    : `/api/ask/${arxivId}`;
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

export async function fetchConversations(arxivId: string): Promise<ChatMessage[]> {
  const r = await fetch(`/api/conversations/${arxivId}`);
  const body = await r.json();
  return body.messages.map((m: { role: ChatMessage["role"]; content: string }) => ({
    role: m.role,
    content: m.content,
  }));
}
