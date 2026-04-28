"""Argv construction for `claude -p` and `codex exec` with security flags baked in.

This is the SINGLE place that translates a typed AI job into a shell command.
Both the host-mode dispatcher (ai_backend.py, subprocess driver) and the
atlas-ai-runner share it, so security flags are always set identically.

Invariants enforced here:
- codex always gets `--sandbox read-only` AND `-c sandbox_mode="read-only"`
  (double-override against any ambient ~/.codex/config.toml). codex has no
  per-domain network control, so the only safe posture is no network.
- claude gets `Read` and a *domain-pinned* `WebFetch` (arxiv only) when the
  caller passes `enable_read_file`. WebFetch is safe to enable here because
  Claude restricts it to the listed domains — a malicious PDF cannot exfil
  data to an attacker host. Never Write/Bash, never unrestricted WebFetch.
- Models pass a shape check only (non-empty, no leading `-`, ≤ MAX_MODEL_LEN
  chars); the CLIs reject unknown slugs themselves with their own errors.
- Directives are non-empty, must not start with `-`, and on the codex side
  go after `--` so they can never be reinterpreted as flags.
"""

from __future__ import annotations

from typing import Literal


Backend = Literal["claude", "codex"]
Task = Literal["summarize", "ask", "rank", "glossary", "podcast"]

MAX_MODEL_LEN = 64

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


def validate_model(backend: Backend, model: str) -> None:
    """Shape check only. The downstream CLI decides if the slug is real."""
    if not model:
        raise ValueError("model must be non-empty")
    if model.startswith("-"):
        raise ValueError("model must not start with '-'")
    if len(model) > MAX_MODEL_LEN:
        raise ValueError(f"model exceeds {MAX_MODEL_LEN} chars")


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
            # Domain-pinned WebFetch lets Claude pull cited arXiv papers /
            # ar5iv HTML when answering — but Claude refuses any URL outside
            # the listed hosts, so a prompt-injected PDF can't exfil to an
            # attacker domain. Never Bash, never Write, never unrestricted
            # WebFetch.
            argv += [
                "--allowedTools",
                "Read,"
                "WebFetch(domain:arxiv.org),"
                "WebFetch(domain:export.arxiv.org),"
                "WebFetch(domain:ar5iv.labs.arxiv.org)",
            ]
        if model == "opus" and task == "summarize":
            argv += ["--effort", "max"]
        argv += ["-p", directive]
        return argv

    # codex
    argv = ["codex", "exec", "--json", *_CODEX_LOCKDOWN, "--model", model]
    # `--` separator: everything after is positional, never a flag.
    argv += ["--", directive]
    return argv
