"""Live full-text search via the arXiv API.

Atlas no longer maintains a local FTS5 index — there's no persistent
paper cache to index. Each search call hits arXiv directly with an
`all:` keyword query, mirroring the live-fetch model used by the
digest endpoint.
"""

from __future__ import annotations

import logging
import re

from app import arxiv


log = logging.getLogger(__name__)

# Strip anything that arXiv's query parser would treat as syntax. Keeping
# this conservative (alphanumerics + whitespace + dash + underscore)
# prevents stray quotes/parens from blowing up an otherwise valid search.
_SAFE_QUERY = re.compile(r"[^A-Za-z0-9\s_\-]")


def _build_query(raw: str) -> str:
    cleaned = _SAFE_QUERY.sub(" ", raw)
    tokens = [t for t in cleaned.split() if t]
    if not tokens:
        return ""
    # Quote each token so multi-word queries don't get split into separate
    # OR-ed terms by arXiv's parser. `all:` searches title+abstract+authors.
    return " AND ".join(f'all:"{t}"' for t in tokens)


async def search(query: str, limit: int = 20) -> list[dict]:
    """Return up to `limit` arXiv hits for `query`, newest first.

    Empty queries return []. Network errors return [] (callers see no
    results rather than a 500). Each result has the same shape the SPA
    expects: arxiv_id, title, authors, snippet, rank.
    """
    if not query or not query.strip():
        return []
    expr = _build_query(query)
    if not expr:
        return []

    try:
        papers = await arxiv.fetch_recent(expr, max_results=int(limit), timeout=20.0)
    except Exception as exc:  # noqa: BLE001 — surface as empty result, not 500
        log.warning("search: arxiv fetch failed (%s): %s", type(exc).__name__, exc)
        return []

    out: list[dict] = []
    for i, p in enumerate(papers):
        # No FTS5 ranking is available; return papers in arXiv's submitted-date
        # order (descending) and surface a tiny abstract excerpt as the snippet.
        snippet = p.abstract[:240] + ("..." if len(p.abstract) > 240 else "")
        out.append(
            {
                "arxiv_id": p.arxiv_id,
                "title": p.title,
                "authors": p.authors,
                "snippet": snippet,
                "rank": float(i),
            }
        )
    return out
