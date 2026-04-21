"""Argv construction for `claude -p` and `codex exec` with security flags baked in.

This is the SINGLE place that translates a typed AI job into a shell command.
Both the host-mode dispatcher (ai_backend.py, subprocess driver) and the
atlas-ai-runner share it, so security flags are always set identically.

Invariants enforced here:
- codex always gets `--sandbox read-only` AND `-c sandbox_mode="read-only"`
  (double-override against any ambient ~/.codex/config.toml).
- claude only gets tool access when the caller explicitly passes
  `enable_read_file`; even then it's Read-only, no Write/Bash/WebFetch.
- Directives and models come from allowlists; anything else raises ValueError.
- The directive is passed through `--` on the codex side so it can never be
  reinterpreted as a flag.
"""

from __future__ import annotations

from typing import Literal


Backend = Literal["claude", "codex"]
Task = Literal["summarize", "ask", "rank", "glossary"]

CLAUDE_MODELS = frozenset({"opus", "sonnet", "haiku"})
# Codex CLI model identifiers (as of codex-cli 0.121). These match the strings
# codex accepts via `-m`. Dotted names are real.
CODEX_MODELS = frozenset({
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
})

# Claude stream flags — NDJSON partial-message streaming.
_CLAUDE_STREAM = (
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
)

# Codex locking flags — enforced on EVERY invocation.
# `--skip-git-repo-check` is required because Atlas spawns codex from the data
# dir (~/.atlas/), which is not a git repo. Without this flag codex refuses to
# start with an exit-1 "Not inside a trusted directory" error.
_CODEX_LOCKDOWN = (
    "--sandbox", "read-only",
    "-c", 'sandbox_mode="read-only"',
    "--skip-git-repo-check",
)


def allowed_models(backend: Backend) -> frozenset[str]:
    return CLAUDE_MODELS if backend == "claude" else CODEX_MODELS


def validate_model(backend: Backend, model: str) -> None:
    if model not in allowed_models(backend):
        raise ValueError(f"model {model!r} not in allowlist for backend {backend!r}")


def build_argv(
    backend: Backend,
    task: Task,
    model: str,
    directive: str,
    enable_read_file: bool = False,
) -> list[str]:
    """Return the fully-formed argv for a subprocess invocation.

    `directive` is the short instruction (e.g. "Produce the deep summary.").
    The bulk prompt goes through stdin, not argv.
    """
    validate_model(backend, model)
    if not directive or directive.startswith("-"):
        raise ValueError("directive must be non-empty and not start with '-'")

    if backend == "claude":
        argv = ["claude", *_CLAUDE_STREAM, "--model", model]
        if enable_read_file:
            argv += ["--allowedTools", "Read"]
        if model == "opus" and task == "summarize":
            argv += ["--effort", "max"]
        argv += ["-p", directive]
        return argv

    # codex
    argv = ["codex", "exec", "--json", *_CODEX_LOCKDOWN, "--model", model]
    # `--` separator: everything after is positional, never a flag.
    argv += ["--", directive]
    return argv
