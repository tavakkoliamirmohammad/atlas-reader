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
_ABBREV: Final[frozenset[str]] = frozenset({
    "e.g", "i.e", "etc", "vs", "fig", "eq", "al",
    "mr", "mrs", "dr", "prof", "sec", "approx", "cf",
    "ph.d",
})

# Boundary candidates: a period/question/exclamation followed by whitespace
# and a sentence-opening character (uppercase letter, opening paren/bracket,
# or quote).
_BOUNDARY = re.compile(r'(?<=[.!?])\s+(?=[A-Z(\["\'])')

# A word ending in a period — used to detect abbreviations at split candidates.
_TRAILING_WORD = re.compile(r'([\w.]+)\.\s*$')

# A digit-period-digit sequence — protects decimals like "0.5".
_DECIMAL = re.compile(r'\d\.\d')


def split_sentences(text: str) -> list[str]:
    """Split `text` into sentences. Preserves trailing punctuation; trims whitespace."""
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return []

    # First pass: candidate splits at every regex boundary.
    candidates = _split_keep_with_terminator(text)

    # Merge candidates whose join point is actually inside an abbreviation
    # or a decimal, not a real sentence boundary.
    out: list[str] = []
    buf = ""
    for piece in candidates:
        if buf and _ends_in_protected_period(buf):
            buf = (buf + " " + piece).strip()
        else:
            if buf:
                out.append(buf)
            buf = piece
    if buf:
        out.append(buf)
    return [s.strip() for s in out if s.strip()]


def _split_keep_with_terminator(text: str) -> list[str]:
    """Split on the boundary regex, preserving terminators with the left piece."""
    parts = _BOUNDARY.split(text)
    return [p.strip() for p in parts if p.strip()]


def _ends_in_protected_period(s: str) -> bool:
    """True if `s` ends with an abbreviation period or a decimal-style period."""
    # Decimal protection: "...0.5" — the period belongs to a number.
    if _DECIMAL.search(s[-3:]):
        return True
    m = _TRAILING_WORD.search(s)
    if not m:
        return False
    word = m.group(1).lower().rstrip('.')
    return word in _ABBREV
