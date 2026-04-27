"""Lightweight sentence splitter tuned for spoken-word scripts.

Pure function, no deps. Designed to be swapped for `pysbd` or similar
later if quality demands it — keep the interface stable: input is a
string, output is a list of sentence strings.
"""

from __future__ import annotations

import re
from typing import Final

# Tokens that look like sentence terminators but aren't. Lowercase keys;
# the period that ends the abbreviation is implicit.
#
# "no" is intentionally absent: it would suppress the legitimate split in
# "The answer is no. Then we tried again." — the English negation is far
# more common in scripts than the ordinal abbreviation "No. 3".
_ABBREV: Final[frozenset[str]] = frozenset({
    "e.g", "i.e", "etc", "vs", "fig", "eq", "al",
    "mr", "mrs", "dr", "prof", "sec", "approx", "cf",
    "ph.d",
})

# Boundary candidates: a period/question/exclamation followed by whitespace
# and a sentence-opening character. The lookahead set covers ASCII uppercase
# letters, opening paren/bracket, ASCII straight quotes, and the common
# Unicode left curly quotes (U+201C double, U+2018 single) that LLMs emit.
# Decimals like "0.5" are inherently protected: the period has no whitespace
# after it, so this regex never matches inside a number.
_BOUNDARY = re.compile(r'(?<=[.!?])\s+(?=[A-Z(\["\'“‘])')

# A word ending in a period — used to detect abbreviations at split candidates.
_TRAILING_WORD = re.compile(r'([\w.]+)\.\s*$')


def split_sentences(text: str) -> list[str]:
    """Split `text` into sentences. Preserves trailing punctuation; trims whitespace."""
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return []

    candidates = _candidate_split(text)

    # Merge candidates whose join point is actually inside an abbreviation,
    # not a real sentence boundary.
    out: list[str] = []
    buf = ""
    for piece in candidates:
        if buf and _ends_in_abbrev(buf):
            buf = (buf + " " + piece).strip()
        else:
            if buf:
                out.append(buf)
            buf = piece
    if buf:
        out.append(buf)
    return [s.strip() for s in out if s.strip()]


def _candidate_split(text: str) -> list[str]:
    """Split on `_BOUNDARY`. Lookbehind keeps the terminator on the left piece."""
    parts = _BOUNDARY.split(text)
    return [p.strip() for p in parts if p.strip()]


def _ends_in_abbrev(s: str) -> bool:
    """True if `s` ends with a known abbreviation followed by its period."""
    m = _TRAILING_WORD.search(s)
    if not m:
        return False
    word = m.group(1).lower().rstrip('.')
    return word in _ABBREV
