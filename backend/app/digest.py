"""Per-request arXiv digest with one-shot OR query + small in-memory cache.

Two design choices that drive the rate-limit posture:

1. **One arXiv request per (cats, days) tuple, not per category.** The Atom
   export API supports `cat:cs.PL OR cat:cs.AR OR ...` — a single request
   that returns the union sorted by submittedDate desc. With 4 default
   categories that drops us from 4 parallel requests per page load to 1.
   Within arXiv's "no more than 1 request every 3 seconds" guidance.
2. **Process-local memory cache, no SQLite.** Atlas is single-user; lost
   cache on container restart is fine. The cost of persisting a cache row
   (and the schema migration that comes with it) isn't worth it given the
   hit volume is one entry per range visited per session.
"""

from __future__ import annotations

import logging
import re
import time as _time
from datetime import datetime, timedelta, timezone
from typing import Iterable

import httpx

from app import arxiv


log = logging.getLogger("atlas.digest")

# Category list defaults / caps. Public so main.py can show them in errors.
DEFAULT_CATEGORIES: tuple[str, ...] = ("cs.PL", "cs.AR", "cs.DC", "cs.PF")
MAX_CATEGORIES = 30
# Combined-query response cap. With N categories OR-joined, results aren't
# split per-category, so we ask for up to ~N×100 to cover the worst case
# (every category active and dense). Capped at 1000 because arXiv's export
# API tops out there.
MAX_PER_REQUEST = 400
FETCH_TIMEOUT_S = 30.0
# 30-minute in-memory TTL. Long enough that page reloads + range toggles
# within a reading session feel instant; short enough that "I started
# Atlas this morning, opened it again at lunch" picks up new arXiv
# announcements without the user reaching for refresh.
CACHE_TTL_S = 30 * 60
# Hard cap on `?days=` so a misbehaving client can't ask for "the last
# 50000 days." 90 covers every preset (1 / 3 / 7 / 14 / 30) plus headroom.
MAX_DAYS = 90

# arXiv category codes look like ``cs.PL``, ``math.OC``, ``stat.ML``, or bare
# archive prefixes like ``physics`` / ``q-bio``. This regex is permissive
# enough to cover all of them while rejecting anything that could smuggle
# operators or whitespace into the search query.
_ARXIV_CAT = re.compile(r"^[a-z][a-z\-]*(\.[A-Z]{2})?$")

# {(sorted-cat-tuple, days): (fetched_at, papers)} — wiped on restart.
_cache: dict[tuple[tuple[str, ...], int | None], tuple[float, list[arxiv.Paper]]] = {}


class InvalidCategory(ValueError):
    """A user-supplied category didn't match the arXiv code shape."""


class TooManyCategories(ValueError):
    """User passed more than ``MAX_CATEGORIES`` categories."""


class InvalidDays(ValueError):
    """``?days=`` was non-positive or above ``MAX_DAYS``."""


def parse_days(raw: str | None) -> int | None:
    """Validate ``?days=N`` (None / blank means no time-window filter)."""
    if raw is None or not raw.strip():
        return None
    try:
        n = int(raw)
    except ValueError as exc:
        raise InvalidDays(f"days must be an integer, got {raw!r}") from exc
    if n <= 0 or n > MAX_DAYS:
        raise InvalidDays(f"days must be 1..{MAX_DAYS}, got {n}")
    return n


def _date_window_clause(days: int) -> str:
    """Build the arXiv ``submittedDate:[start TO end]`` filter for the last
    ``days`` days. arXiv expects ``YYYYMMDDHHMM`` in UTC."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    fmt = "%Y%m%d%H%M"
    return f"submittedDate:[{start.strftime(fmt)} TO {end.strftime(fmt)}]"


def parse_categories(raw: str | None) -> tuple[str, ...]:
    """Validate ``?cats=...`` and fall back to defaults if absent.

    Raises ``InvalidCategory`` / ``TooManyCategories`` so the route layer
    can map them to 400 responses with a useful message.
    """
    if raw is None or not raw.strip():
        return DEFAULT_CATEGORIES
    seen: list[str] = []
    for token in raw.split(","):
        c = token.strip()
        if not c:
            continue
        if not _ARXIV_CAT.match(c):
            raise InvalidCategory(f"invalid arxiv category: {c!r}")
        if c not in seen:
            seen.append(c)
    if not seen:
        return DEFAULT_CATEGORIES
    if len(seen) > MAX_CATEGORIES:
        raise TooManyCategories(f"too many categories (max {MAX_CATEGORIES})")
    return tuple(seen)


def paper_to_dict(p: arxiv.Paper) -> dict:
    """Match the legacy ``papers`` row shape so the SPA Paper type is unchanged."""
    return {
        "arxiv_id": p.arxiv_id,
        "title": p.title,
        "authors": p.authors,
        "abstract": p.abstract,
        "categories": p.categories,
        "published": p.published,
        "pdf_path": None,
        "ai_tier": None,
        "ai_score": None,
        "read_state": "unread",
    }


def classify_fetch_error(exc: BaseException) -> str:
    """Classify an arXiv fetch failure into a stable string the SPA renders.

    The backend already retries 429/503 with backoff; if we still see one
    here, the API is genuinely throttling our IP and the right thing for
    the UI is to say so plainly.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        sc = exc.response.status_code
        if sc in (429, 503):
            return "rate_limited"
        return f"http_{sc}"
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return "unreachable"
    return type(exc).__name__


def clear_cache() -> None:
    """Drop every cached digest entry. Used by tests."""
    _cache.clear()


def _build_query(cats: tuple[str, ...], days: int | None) -> str:
    """One arXiv search_query string covering all categories at once.

    `cat:cs.PL OR cat:cs.AR OR ...` joins the categories into a single
    union; appending the submittedDate window keeps the result trimmed to
    the user's range without N parallel requests.
    """
    cat_clause = " OR ".join(f"cat:{c}" for c in cats)
    # Parens isolate the OR — without them arXiv would AND the date
    # filter against only the LAST cat:... fragment.
    if days is not None:
        return f"({cat_clause}) AND {_date_window_clause(days)}"
    return cat_clause


async def build(
    categories: Iterable[str], *, fresh: bool, days: int | None = None,
) -> dict:
    """Run a single combined arXiv query and return the JSON-ready dict.

    The cache key includes the sorted category tuple AND the days window;
    different ranges are independent entries. ``fresh=True`` bypasses the
    cache and overwrites the entry on success.
    """
    cats = tuple(categories)
    cache_key = (tuple(sorted(cats)), days)

    if not fresh:
        entry = _cache.get(cache_key)
        if entry is not None and (_time.monotonic() - entry[0]) < CACHE_TTL_S:
            papers = entry[1]
            return _shape(cats, days, papers, failures=[])

    query = _build_query(cats, days)
    failures: list[dict] = []
    try:
        papers = await arxiv.fetch_recent(
            query, max_results=MAX_PER_REQUEST, timeout=FETCH_TIMEOUT_S,
        )
        _cache[cache_key] = (_time.monotonic(), papers)
    except Exception as exc:  # noqa: BLE001 — we want to surface every kind
        kind = classify_fetch_error(exc)
        log.warning("digest: fetch failed kind=%s cats=%s days=%s err=%s",
                    kind, cats, days, exc)
        failures.append({"category": ",".join(cats), "kind": kind})
        papers = []

    return _shape(cats, days, papers, failures=failures)


def _shape(
    cats: tuple[str, ...],
    days: int | None,
    papers: list[arxiv.Paper],
    *,
    failures: list[dict],
) -> dict:
    """Assemble the response shape — sorted desc by submittedDate."""
    items = sorted(papers, key=lambda p: p.published, reverse=True)
    return {
        "count": len(items),
        "papers": [paper_to_dict(p) for p in items],
        "categories": list(cats),
        "failures": failures,
        "days": days,
    }
