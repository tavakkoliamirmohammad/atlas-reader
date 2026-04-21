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

export type Backend = "claude" | "codex";

export type HealthResponse = {
  ai: boolean;
  backends?: { claude: boolean; codex: boolean };
  default_backend?: Backend;
  papers_today: number;
};
export type DigestResponse = { count: number; papers: Paper[] };

// Defined here (not imported from the ui-store) to avoid a circular import:
// ui-store.ts imports `HighlightColor` + `ModelChoice` from this module.
export type DigestRange = 3 | 7 | 14 | 30 | "all";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health:  () => getJson<HealthResponse>("/api/health"),
  digest:  (build = false, days: DigestRange = 7, backend?: Backend) => {
    const params = new URLSearchParams();
    if (build) params.set("build", "true");
    params.set("days", String(days));
    if (backend) params.set("backend", backend);
    const qs = params.toString();
    return getJson<DigestResponse>(`/api/digest${qs ? `?${qs}` : ""}`);
  },
  paper:   (id: string) => getJson<Paper>(`/api/papers/${encodeURIComponent(id)}`),
  pdfUrl:  (id: string) => `/api/pdf/${encodeURIComponent(id)}`,
};

export type ModelChoice = "opus" | "sonnet" | "haiku";

// Codex models mirror backend/app/ai_argv.CODEX_MODELS. Keep in sync with what
// `codex --help` / "Select Model" actually lists in codex-cli.
export type CodexModel =
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "gpt-5.3-codex"
  | "gpt-5.2"
  | "gpt-5.2-codex"
  | "gpt-5.1-codex-max"
  | "gpt-5.1-codex-mini";

export const CODEX_MODEL_OPTIONS: CodexModel[] = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
];

// Single type used by UI state when it needs to reference either backend's
// model identifier. Each backend has its own picker that narrows to its type.
export type AnyModel = ModelChoice | CodexModel;

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  model?: AnyModel;
};

export async function streamSummary(
  arxivId: string,
  handlers: SSEHandlers,
  signal?: AbortSignal,
  model?: AnyModel,
  backend?: Backend,
): Promise<void> {
  const url = _withQuery(`/api/summarize/${arxivId}`, { model, backend });
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
  model?: AnyModel,
  backend?: Backend,
): Promise<void> {
  const url = _withQuery(`/api/ask/${arxivId}`, { model, backend });
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

export type HighlightColor = "yellow" | "coral" | "blue";

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Highlight = {
  id: number;
  arxiv_id: string;
  quote: string;
  color: HighlightColor;
  page: number | null;
  note: string | null;
  rects: SelectionRect[] | null;
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
  input: {
    quote: string;
    color: HighlightColor;
    page?: number | null;
    note?: string | null;
    rects?: SelectionRect[] | null;
  },
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

export async function importPdfUrl(url: string): Promise<string> {
  const r = await fetch("/api/papers/import-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `import-url -> ${r.status}`);
  return body.arxiv_id as string;
}


export async function importPdfUpload(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  const r = await fetch("/api/papers/import-upload", { method: "POST", body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `import-upload -> ${r.status}`);
  return body.arxiv_id as string;
}


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
