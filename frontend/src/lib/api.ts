import { streamSSE, type SSEHandlers } from "./sse";

// Build-time base URL for the Atlas backend.
//   - Dev / same-origin bundled mode: leave unset → fetch("/api/x") hits the
//     vite proxy (dev) or same origin (when the backend serves the SPA).
//   - Hosted mode (Cloudflare Pages / GitHub Pages): set VITE_API_BASE to the
//     user's local backend, e.g. "http://localhost:8765". Each user then talks
//     to their own `atlas up` — no shared backend, no shared AI.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** Prefix a relative API path with the configured base URL. */
export const u = (path: string): string => `${API_BASE}${path}`;

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
  tts?: boolean;
  backends?: { claude: boolean; codex: boolean };
  default_backend?: Backend;
};
export type DigestFailure = {
  category: string;
  /**
   * Stable identifiers so the UI can localize the message:
   *   "rate_limited" | "unreachable" | "http_<status>" | <ExceptionName>
   */
  kind: string;
};

export type DigestResponse = {
  count: number;
  papers: Paper[];
  /** Echoes back the categories the server actually fetched. */
  categories?: string[];
  /** Per-category fetch failures, for UI to surface graceful errors. */
  failures?: DigestFailure[];
};

// Defined here (not imported from the ui-store) to avoid a circular import:
// ui-store.ts imports `HighlightColor` + `ModelChoice` from this module.
// Used purely for client-side range filtering — the backend always returns
// the full live arXiv fetch and the SPA filters by `published` itself.
export type DigestRange = 3 | 7 | 14 | 30 | "all";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(u(path));
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health:  () => getJson<HealthResponse>("/api/health"),
  digest:  (categories?: string[], fresh: boolean = false) => {
    const params = new URLSearchParams();
    if (categories?.length) params.set("cats", categories.join(","));
    if (fresh) params.set("fresh", "true");
    const qs = params.toString();
    return getJson<DigestResponse>(`/api/digest${qs ? `?${qs}` : ""}`);
  },
  paper:   (id: string) => getJson<Paper>(`/api/papers/${encodeURIComponent(id)}`),
  pdfUrl:  (id: string) => u(`/api/pdf/${encodeURIComponent(id)}`),
};

// Claude side stays as three stable aliases — the Anthropic CLI auto-resolves
// each to the latest concrete model, so this set rarely needs editing.
export type ModelChoice = "opus" | "sonnet" | "haiku";

// Codex models are discovered at runtime from the codex CLI's own model cache
// via /api/models. Anything goes — the picker shows whatever codex itself can
// reach today, no hardcoded enum to drift.
export type CodexModel = string;

export type CodexModelInfo = {
  slug: CodexModel;
  label: string;
  description: string;
};

export async function getCodexModels(): Promise<CodexModelInfo[]> {
  const r = await fetch(u("/api/models?backend=codex"));
  if (!r.ok) {
    throw new Error(`getCodexModels ${r.status}: ${await r.text()}`);
  }
  const data = (await r.json()) as { models: CodexModelInfo[] };
  return data.models;
}

// Single type used by UI state when it needs to reference either backend's
// model identifier. Each backend has its own picker.
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
  return streamSSE(u(url), { method: "POST" }, handlers, signal);
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
  display?: string,
): Promise<void> {
  const url = _withQuery(`/api/ask/${arxivId}`, { model, backend });
  return streamSSE(
    u(url),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `display` is what gets persisted as the user's message and shown in
      // the bubble. `question` stays internal — the model sees it, but the
      // chat log never does.
      body: JSON.stringify({ question, history, display }),
    },
    handlers,
    signal,
  );
}

export async function fetchConversations(arxivId: string): Promise<ChatMessage[]> {
  const r = await fetch(u(`/api/conversations/${arxivId}`));
  const body = await r.json();
  return body.messages.map(
    (m: { role: ChatMessage["role"]; content: string; model?: string | null }) => ({
      role: m.role,
      content: m.content,
      model: (m.model as AnyModel) ?? undefined,
    }),
  );
}


export async function clearConversation(arxivId: string): Promise<void> {
  const r = await fetch(u(`/api/conversations/${encodeURIComponent(arxivId)}`), {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`clearConversation -> ${r.status}`);
  }
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
  const r = await fetch(u(`/api/highlights/${encodeURIComponent(arxivId)}`));
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
  const r = await fetch(u(`/api/highlights/${encodeURIComponent(arxivId)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`POST /api/highlights/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.id as number;
}

export async function deleteHighlight(id: number): Promise<void> {
  const r = await fetch(u(`/api/highlights/${id}`), { method: "DELETE" });
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
  const r = await fetch(u(`/api/glossary/${encodeURIComponent(arxivId)}`));
  if (!r.ok) throw new Error(`/api/glossary/${arxivId} -> ${r.status}`);
  const body = await r.json();
  return body.terms as GlossaryTerm[];
}

export async function extractGlossary(arxivId: string): Promise<GlossaryTerm[]> {
  const r = await fetch(
    u(`/api/glossary/${encodeURIComponent(arxivId)}/extract`),
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
    u(`/api/glossary/${encodeURIComponent(arxivId)}/${encodeURIComponent(term)}/definition`),
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
  const r = await fetch(u("/api/papers/import-url"), {
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
  const r = await fetch(u("/api/papers/import-upload"), { method: "POST", body: form });
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
  const r = await fetch(u(url), { signal });
  if (!r.ok) throw new Error(`/api/search -> ${r.status}`);
  const body: SearchResponse = await r.json();
  return body.results;
}
