"""Stream a chat answer using `claude -p`. Ephemeral — does NOT persist messages.

Per user privacy preference: conversations live only in the frontend's React
state. They evaporate when the user switches papers or refreshes the page.
"""

from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator, List, TypedDict

from app import claude_subprocess, papers, pdf_cache


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
    model: str = "sonnet",
) -> AsyncIterator[str]:
    """Yield answer chunks as they stream. No DB writes."""
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

    async for chunk in claude_subprocess.run_streaming(
        ["--model", model, "--allowedTools", "Read", "-p", "Answer the question."],
        stdin_text=prompt,
    ):
        yield chunk
