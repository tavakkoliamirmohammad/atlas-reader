"""Extract text chunks from the NDJSON stream emitted by `claude -p` / `codex exec --json`.

Both CLIs emit newline-delimited JSON events. We only care about two things:
- *delta* events → yield now, one chunk per event, for live UI streaming.
- *final* events → yield at end as a fallback when no deltas were seen
  (older CLI versions, or runs where the model didn't stream).

Event shapes vary across CLI versions; the extractors are intentionally
permissive — unknown events are silently skipped, not erroring.
"""

from __future__ import annotations

from typing import Optional


def claude_delta(event: dict) -> Optional[str]:
    """Claude `stream_event` → `content_block_delta` → `text_delta.text`."""
    if event.get("type") != "stream_event":
        return None
    ev = event.get("event") or {}
    if ev.get("type") != "content_block_delta":
        return None
    delta = ev.get("delta") or {}
    if delta.get("type") != "text_delta":
        return None
    return delta.get("text") or None


def claude_final(event: dict) -> Optional[str]:
    """Claude final `assistant` message — fallback when partials unsupported."""
    if event.get("type") != "assistant":
        return None
    msg = event.get("message") or {}
    parts: list[str] = []
    for block in msg.get("content") or []:
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
    return "".join(parts) or None


def codex_delta(event: dict) -> Optional[str]:
    """Extract text from a codex-cli `exec --json` event.

    Codex (v0.121) does NOT stream token-level deltas for text — it emits
    whole messages as `item.completed` events with `item.type == "agent_message"`.
    There can be several `agent_message` items in one run (thinking preamble,
    tool-use narration, final answer). We yield each as it completes; the
    caller treats them as streaming chunks so they render live.

    Tool-use events (`command_execution`, `file_change`, etc.) are ignored so
    the user doesn't see raw shell output; their narration comes through via
    the accompanying `agent_message` items.

    Appends a blank-line separator to each chunk: adjacent agent messages
    would otherwise concatenate without a break, gluing narration like
    "...tied to the paper." to the start of the final answer "## 1. …",
    which markdown then renders as inline prose instead of a heading (same
    failure mode turns "- A new idea" into "...results.- A new idea").
    """
    if event.get("type") != "item.completed":
        return None
    item = event.get("item") or {}
    if item.get("type") != "agent_message":
        return None
    text = item.get("text")
    if isinstance(text, str) and text:
        return text if text.endswith("\n\n") else text + "\n\n"
    return None


def codex_final(event: dict) -> Optional[str]:
    """Codex doesn't have a distinct "final" event separate from per-item
    completions; delta covers it. Kept for interface symmetry with Claude.
    """
    return None


def codex_error(event: dict) -> Optional[str]:
    """Extract a human-readable error message from a codex error/fail event.

    Codex emits `{"type":"error","message":"..."}` and/or
    `{"type":"turn.failed","error":{"message":"..."}}` when a run fails
    (e.g. model not available on your plan, rate limit, invalid args). The
    `message` is often itself a JSON blob, so we try to unwrap one level.
    """
    import json as _json
    raw: Optional[str] = None
    if event.get("type") == "error":
        raw = event.get("message")
    elif event.get("type") == "turn.failed":
        err = event.get("error") or {}
        raw = err.get("message") if isinstance(err, dict) else None
    if not isinstance(raw, str) or not raw:
        return None
    # Often the message is a nested JSON string from OpenAI's API layer.
    stripped = raw.strip()
    if stripped.startswith("{"):
        try:
            inner = _json.loads(stripped)
            if isinstance(inner, dict):
                err_obj = inner.get("error") or {}
                if isinstance(err_obj, dict):
                    msg = err_obj.get("message")
                    if isinstance(msg, str) and msg:
                        return msg
                msg = inner.get("message")
                if isinstance(msg, str) and msg:
                    return msg
        except _json.JSONDecodeError:
            pass
    return raw


def extract(backend: str, event: dict) -> tuple[Optional[str], Optional[str]]:
    """Return (delta, final) for an event. Either, both, or neither may be None."""
    if backend == "claude":
        return claude_delta(event), claude_final(event)
    if backend == "codex":
        return codex_delta(event), codex_final(event)
    return None, None
