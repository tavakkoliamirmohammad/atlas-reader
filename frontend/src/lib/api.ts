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
