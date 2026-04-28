"""Stream a chat answer about a paper, persist the turn after streaming completes.

Design:
- The frontend sends the full in-memory history on every call (same as before).
- We apply a sliding-window token budget to that history so the prompt stays
  bounded even on 500-turn threads.
- After the stream finishes, we append both the user question and the full
  assistant response to the conversations table, so the thread survives a
  refresh / paper-switch / backend restart.
- We strip leading "tool-use narration" (codex announcing fallback paths,
  status updates about reading the PDF, etc.) before yielding to the SPA.
  Codex emits these from its tool runtime, not the LLM, so the prompt's
  "do not narrate" rule can't suppress them — only output filtering can.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import AsyncIterator, List, Optional, TypedDict

from app import ai_backend, conversations, papers, pdf_cache


SYSTEM_PATH = Path(__file__).parent / "prompts" / "chat_system.txt"

# Approx char budget for PRIOR CONVERSATION: 32 KB ≈ 8K tokens (rule of thumb
# ~4 chars/token). Below this, history flows through untouched. Above it, we
# drop oldest turns (paired user+assistant) until we fit, prepended with a
# single line noting the trim.
MAX_PRIOR_CHARS = 32_000
TRIM_NOTE = "[earlier messages in this thread were trimmed to keep the prompt within budget]"

# How many leading characters we'll buffer before deciding what's narration.
# Held just long enough to land on the first paragraph break; large enough
# that even a chatty model's preamble fits inside it.
_NARRATION_BUFFER_CAP = 1200

# Patterns the codex tool runtime emits when it falls back from one tool path
# to another, or when it announces what it's about to do. Each matches a
# single sentence ending in `.`, `!`, `?`, or newline. Order doesn't matter —
# the strip loop applies them iteratively from the start of the buffer.
_NARRATION_PATTERNS = [
    # The exact codex sandbox-fallback line we've seen in production.
    r"The [a-z ]+? path hit a sandbox issue[^.!?\n]*[.!?]",
    # "Switching to a local text-extraction route…" and variants.
    r"(?:I[’']?m |I[’']?ll )?[Ss]witching to (?:a |the )?[a-z\- ]+route[^.!?\n]*[.!?]",
    # "I'm going to read the PDF." / "I'll pull the evaluation details."
    r"I[’']?m (?:going to |about to |now )?(?:read|pull|extract|grab|fetch|look up|consult|search|check|extracting|reading)[^.!?\n]*[.!?]",
    r"I[’']?ll (?:read|pull|extract|grab|fetch|look up|consult|search|check)[^.!?\n]*[.!?]",
    r"Now I[’']?ll [^.!?\n]*[.!?]",
    # "Reading the PDF…" / "Reading section 4.2…"
    r"Reading (?:the |from )?(?:PDF|file|section|paper)[^.!?\n]*[.!?]",
]
_NARRATION_RE = re.compile(
    r"^(?:" + "|".join(_NARRATION_PATTERNS) + r")\s*",
    re.IGNORECASE,
)


def _strip_known_narration(text: str) -> str:
    """Strip up to a handful of leading narration sentences."""
    out = text.lstrip()
    for _ in range(5):
        prev = out
        out = _NARRATION_RE.sub("", out, count=1).lstrip()
        if out == prev:
            break
    return out


async def _strip_narration(stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """Drop leading tool-use narration without delaying real content.

    Buffers chunks until either:
      - we see a paragraph break (`\\n\\n`), at which point the head is
        passed through `_strip_known_narration` and the tail flows straight
        through; or
      - we've buffered _NARRATION_BUFFER_CAP characters without a break,
        at which point we strip what we can and start passing through.

    Once the prefix is decided, every subsequent chunk is yielded as-is
    so streaming feels live.
    """
    buffer = ""
    decided = False
    async for chunk in stream:
        if decided:
            yield chunk
            continue
        buffer += chunk
        idx = buffer.find("\n\n")
        if idx >= 0:
            head = buffer[: idx + 2]
            tail = buffer[idx + 2 :]
            cleaned = _strip_known_narration(head)
            if cleaned:
                yield cleaned
            if tail:
                yield tail
            buffer = ""
            decided = True
        elif len(buffer) >= _NARRATION_BUFFER_CAP:
            cleaned = _strip_known_narration(buffer)
            if cleaned:
                yield cleaned
            buffer = ""
            decided = True
    if not decided and buffer:
        cleaned = _strip_known_narration(buffer)
        if cleaned:
            yield cleaned


class ChatMessage(TypedDict):
    role: str
    content: str


def _slide_window(history: List[ChatMessage]) -> List[ChatMessage]:
    """Drop oldest-first until total char length fits MAX_PRIOR_CHARS.

    Keeps messages in order. Always keeps at least the newest 2 (user+asst)
    if present — losing them would defeat the purpose.
    """
    if not history:
        return history
    total = sum(len(m["content"]) for m in history)
    if total <= MAX_PRIOR_CHARS:
        return history

    trimmed = list(history)
    # Drop from the front until we fit or only 2 remain.
    while trimmed and total > MAX_PRIOR_CHARS and len(trimmed) > 2:
        dropped = trimmed.pop(0)
        total -= len(dropped["content"])
    return trimmed


def _format_history(history: List[ChatMessage], trimmed: bool) -> str:
    if not history:
        return ""
    lines = []
    for m in history:
        prefix = "USER: " if m["role"] == "user" else "ASSISTANT: "
        lines.append(prefix + m["content"])
    header = f"\n\nPRIOR CONVERSATION:\n"
    if trimmed:
        header += f"{TRIM_NOTE}\n\n"
    return header + "\n\n".join(lines) + "\n"


async def ask(
    arxiv_id: str,
    question: str,
    history: List[ChatMessage],
    *,
    backend: str = ai_backend.DEFAULT_BACKEND,
    model: Optional[str] = None,
    display: Optional[str] = None,
) -> AsyncIterator[str]:
    """Yield answer chunks as they stream, then persist the turn.

    `display` is an optional short label to persist in place of the full
    `question` body. Quick-action chips pass this so the chat log reads
    "Flow diagram" instead of the multi-line prompt template.
    """
    if papers.get(arxiv_id) is None:
        raise KeyError(arxiv_id)

    pdf_path = await pdf_cache.ensure_cached(arxiv_id)
    system = SYSTEM_PATH.read_text()

    windowed = _slide_window(history)
    was_trimmed = len(windowed) != len(history)

    prompt = (
        f"{system}\n\n"
        f"PDF: {pdf_path}\n"
        f"Use the Read tool to read the PDF if needed."
        f"{_format_history(windowed, trimmed=was_trimmed)}"
        f"\n\nUSER QUESTION: {question}\n"
    )

    normalized_backend = ai_backend.normalize_backend(backend)
    resolved_model = model or await ai_backend.default_model(normalized_backend, "ask")

    raw_stream = ai_backend.run_ai(
        backend=normalized_backend,
        task="ask",
        directive="Answer the question.",
        prompt=prompt,
        model=model,
        enable_read_file=str(pdf_path),
    )

    # Collect the streamed chunks so we can persist the complete answer after
    # the stream ends. We persist the FILTERED stream (post narration strip),
    # not the raw model output, so reloading a thread doesn't show the
    # tool-use preamble that we just hid from the live view.
    parts: list[str] = []
    try:
        async for chunk in _strip_narration(raw_stream):
            parts.append(chunk)
            yield chunk
    finally:
        # Persist only if we got SOMETHING back. A totally empty stream
        # usually means the backend errored — no point saving a blank reply
        # that would confuse the next turn.
        answer = "".join(parts).strip()
        if answer:
            user_row_content = (display or "").strip() or question
            conversations.append(arxiv_id, "user", user_row_content)
            conversations.append(arxiv_id, "assistant", answer, model=resolved_model)
