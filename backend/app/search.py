"""Full-text search over cached papers via SQLite FTS5."""

from __future__ import annotations

import re

from app import db


# Keep alphanumerics, whitespace, and a small set of safe FTS5 operators.
# Anything else gets stripped so that user input cannot crash the parser
# (e.g. unbalanced quotes, stray colons, parens).
_SAFE_QUERY = re.compile(r"[^A-Za-z0-9\s_\-]")


def _sanitize(query: str) -> str:
    """Return an FTS5-safe MATCH expression for a free-form user query.

    Each remaining token is wrapped in double quotes and suffixed with the
    prefix-match operator, so 'GPU kernel' becomes '"GPU"* "kernel"*'. This
    gives prefix matching while keeping the parser happy regardless of input.
    """
    cleaned = _SAFE_QUERY.sub(" ", query)
    tokens = [t for t in cleaned.split() if t]
    if not tokens:
        return ""
    return " ".join(f'"{t}"*' for t in tokens)


def search(query: str, limit: int = 20) -> list[dict]:
    """Run an FTS5 MATCH against papers_fts and return ranked hits.

    Empty queries return []. Each result is a dict with keys
    arxiv_id, title, authors, snippet, rank.
    """
    if not query or not query.strip():
        return []
    match = _sanitize(query)
    if not match:
        return []

    sql = """
        SELECT
            f.arxiv_id                                                 AS arxiv_id,
            f.title                                                    AS title,
            f.authors                                                  AS authors,
            snippet(papers_fts, 3, '<mark>', '</mark>', '...', 16)     AS snippet,
            bm25(papers_fts)                                           AS rank
          FROM papers_fts AS f
         WHERE papers_fts MATCH ?
         ORDER BY rank
         LIMIT ?
    """
    with db.connect() as conn:
        try:
            cur = conn.execute(sql, (match, int(limit)))
        except Exception:
            # Defensive: if the sanitized query is somehow still invalid,
            # return no results rather than 500-ing the API.
            return []
        rows = cur.fetchall()
    return [
        {
            "arxiv_id": r["arxiv_id"],
            "title": r["title"],
            "authors": r["authors"],
            "snippet": r["snippet"],
            "rank": r["rank"],
        }
        for r in rows
    ]
