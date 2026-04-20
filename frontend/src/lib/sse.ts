// Native EventSource works for GET-only SSE. For POST + SSE we use fetch + ReadableStream.

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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSSEEvent(raw);
      if (event.event === "error") handlers.onError?.(event.data);
      else if (event.event === "done") handlers.onDone?.();
      else handlers.onChunk(event.data);
    }
  }
  handlers.onDone?.();
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
