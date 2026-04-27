import { u } from "./api";

export type Length = "short" | "medium" | "long";

export type Segment = {
  idx: number;
  text: string;
  start_ms: number;
  end_ms: number;
};

export type Manifest = {
  arxiv_id: string;
  length: Length;
  voice: string;
  model: string;
  backend: string;
  generated_at: number;
  duration_s: number;
  script: string;
  segments: Segment[];
};

export type PodcastEvent =
  | { type: "script_chunk"; text: string }
  | { type: "tts_progress"; synthesized_s: number; total_s_estimate: number }
  | { type: "ready"; url: string; segments: Segment[]; duration_s: number }
  | { type: "error"; phase: string; message: string };

export type GenerateRequest = {
  arxiv_id: string;
  length: Length;
  backend?: string;
  model?: string;
};

export type GenerateHandlers = {
  onEvent: (ev: PodcastEvent) => void;
  onDone?: () => void;
  onError?: (msg: string) => void;
};

/** Open POST /api/podcast and stream structured events to the handlers. */
export async function streamGenerate(
  req: GenerateRequest,
  handlers: GenerateHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(u("/api/podcast"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!resp.ok) {
    handlers.onError?.(`HTTP ${resp.status}`);
    return;
  }
  if (!resp.body) {
    handlers.onError?.("no response body");
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEmitted = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!raw) continue;
        const ev = parseFrame(raw);
        if (ev.event === "done") {
          doneEmitted = true;
          handlers.onDone?.();
          continue;
        }
        if (ev.event === "error") {
          handlers.onError?.(ev.data || "stream error");
          continue;
        }
        try {
          const payload = JSON.parse(ev.data) as PodcastEvent;
          handlers.onEvent(payload);
        } catch {
          // Malformed JSON — surface as error but keep reading; backend should
          // never emit this, but defensive parsing keeps the stream resilient.
          handlers.onError?.(`bad event: ${ev.data}`);
        }
      }
    }
    if (!doneEmitted) handlers.onDone?.();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw err;
  } finally {
    // Release the body's lock so future fetches against the same response
    // don't fail with "ReadableStream is locked." cancel() is idempotent.
    reader.cancel().catch(() => {});
  }
}

function parseFrame(raw: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: dataLines.join("\n") };
}

/** GET the cached manifest. Returns null on 404. */
export async function fetchManifest(arxiv_id: string, length: Length): Promise<Manifest | null> {
  const r = await fetch(u(`/api/podcast/${encodeURIComponent(arxiv_id)}/${length}.json`));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fetchManifest HTTP ${r.status}`);
  return (await r.json()) as Manifest;
}

/** DELETE the cache. Returns whether anything was removed. */
export async function deletePodcast(arxiv_id: string, length: Length): Promise<boolean> {
  const r = await fetch(
    u(`/api/podcast/${encodeURIComponent(arxiv_id)}/${length}`),
    { method: "DELETE" },
  );
  if (!r.ok) throw new Error(`deletePodcast HTTP ${r.status}`);
  const body = (await r.json()) as { removed: boolean };
  return body.removed;
}

/** Construct the audio URL for `<audio src=...>`. */
export function podcastAudioUrl(arxiv_id: string, length: Length): string {
  return u(`/api/podcast/${encodeURIComponent(arxiv_id)}/${length}.mp3`);
}
