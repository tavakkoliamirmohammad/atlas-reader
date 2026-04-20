// Native EventSource works for GET-only SSE. For POST + SSE we use fetch + ReadableStream.
//
// Wire format from the backend:
//   data: {"t": "<chunk>"}\n\n          - normal text delta
//   event: done\ndata: ok\n\n             - terminal "done" sentinel
//   event: error\ndata: {"message": "..."}\n\n - terminal error
//
// The backend JSON-encodes each text chunk so that paragraph breaks (`\n\n`)
// and other whitespace inside the chunk survive transport without colliding
// with SSE's own framing. This file is the inverse: split on `\n\n`, parse
// each event, JSON-decode the payload for "message" + "error" events.

export type SSEHandlers = {
  onChunk: (chunk: string) => void;
  onDone?: () => void;
  onError?: (err: string) => void;
};

export async function streamSSE(
  url: string,
  init: RequestInit,
  handlers: SSEHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(url, { ...init, signal });
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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw) continue;
      const event = parseSSEEvent(raw);
      if (event.event === "error") {
        handlers.onError?.(decodeErrorPayload(event.data));
      } else if (event.event === "done") {
        doneEmitted = true;
        handlers.onDone?.();
      } else {
        const text = decodeChunkPayload(event.data);
        if (text !== null) handlers.onChunk(text);
      }
    }
  }
  if (!doneEmitted) handlers.onDone?.();
}

function parseSSEEvent(raw: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: dataLines.join("\n") };
}

/** Decode a normal `message` event whose data is `{"t": "..."}`. */
function decodeChunkPayload(data: string): string | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as { t?: unknown };
    if (typeof parsed.t === "string") return parsed.t;
    return null;
  } catch {
    // Backwards compat: legacy backend emitted raw text in `data:`. Surface as-is.
    return data;
  }
}

/** Decode an `error` event. Backend sends `{"message": "..."}`; legacy = raw text. */
function decodeErrorPayload(data: string): string {
  if (!data) return "stream error";
  try {
    const parsed = JSON.parse(data) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // fall through to raw
  }
  return data;
}
