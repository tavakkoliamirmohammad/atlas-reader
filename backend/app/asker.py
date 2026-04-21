"""Stream a chat answer about a paper, persist the turn after streaming completes.

Design:
- The frontend sends the full in-memory history on every call (same as before).
- We apply a sliding-window token budget to that history so the prompt stays
  bounded even on 500-turn threads.
- After the stream finishes, we append both the user question and the full
  assistant response to the conversations table, so the thread survives a
  refresh / paper-switch / backend restart.
"""

from __future__ import annotations

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
    resolved_model = model or ai_backend.default_model(normalized_backend, "ask")

    # Collect the streamed chunks so we can persist the complete answer after
    # the stream ends. Yielding happens in real time; persistence is one SQL
    # transaction at the end.
    parts: list[str] = []
    try:
        async for chunk in ai_backend.run_ai(
            backend=normalized_backend,
            task="ask",
            directive="Answer the question.",
            prompt=prompt,
            model=model,
            enable_read_file=str(pdf_path),
        ):
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
