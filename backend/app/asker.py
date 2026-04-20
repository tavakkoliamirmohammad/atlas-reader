"""Stream a chat answer using `claude -p --model sonnet`. Persists messages."""

from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator, List, TypedDict

from app import claude_subprocess, conversations, papers, pdf_cache


SYSTEM_PATH = Path(__file__).parent / "prompts" / "chat_system.txt"


class ChatMessage(TypedDict):
    role: str
    content: str


def _format_history(history: List[ChatMessage]) -> str:
    if not history:
        return ""
    lines = []
    for m in history:
        prefix = "USER: " if m["role"] == "user" else "ASSISTANT: "
        lines.append(prefix + m["content"])
    return "\n\nPRIOR CONVERSATION:\n" + "\n\n".join(lines) + "\n"


async def ask(
    arxiv_id: str,
    question: str,
    history: List[ChatMessage],
) -> AsyncIterator[str]:
    """Yield chunks of the answer; persist user msg up-front, assistant on success."""
    if papers.get(arxiv_id) is None:
        raise KeyError(arxiv_id)

    pdf_path = await pdf_cache.ensure_cached(arxiv_id)
    system = SYSTEM_PATH.read_text()
    prompt = (
        f"{system}\n\n"
        f"PDF: {pdf_path}\n"
        f"Use the Read tool to read the PDF if needed."
        f"{_format_history(history)}"
        f"\n\nUSER QUESTION: {question}\n"
    )

    conversations.append(arxiv_id, "user", question)

    collected: list[str] = []
    async for chunk in claude_subprocess.run_streaming(
        ["--model", "sonnet", "--allowedTools", "Read", "-p", "Answer the question."],
        stdin_text=prompt,
    ):
        collected.append(chunk)
        yield chunk

    conversations.append(arxiv_id, "assistant", "".join(collected))
