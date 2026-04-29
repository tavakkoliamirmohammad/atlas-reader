"""Per-request arXiv digest: live fetch + per-category in-memory cache.

Pulled out of `main.py` so the route handler is just request-handling, with
the orchestration (validate categories, hit cache, fan out to arXiv, classify
errors, marshal to dicts) sitting in a module that can be tested without
standing up FastAPI.

arXiv publishes new submissions on a roughly daily cadence, so a 2-hour
in-memory cache stays fresh for typical reading sessions while making
category toggles, range switches, and follow-up loads instant. The route
exposes ``fresh=true`` as the user's escape hatch.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time as _time
from datetime import datetime, timedelta, timezone
from typing import Iterable

import httpx

from app import arxiv


log = logging.getLogger("atlas.digest")

# Category list defaults / caps. Public so main.py can show them in errors.
DEFAULT_CATEGORIES: tuple[str, ...] = ("cs.PL", "cs.AR", "cs.DC", "cs.PF", "cs.LG")
MAX_CATEGORIES = 30
MAX_PER_CATEGORY = 100
FETCH_TIMEOUT_S = 30.0
CACHE_TTL_S = 2 * 60 * 60
# Hard cap on `?days=` so a misbehaving client can't ask for "the last 50000
# days" and trigger an enormous arXiv query. 90 covers every preset the SPA
# offers (3 / 7 / 14 / 30) plus headroom.
MAX_DAYS = 90

# arXiv category codes look like ``cs.PL``, ``math.OC``, ``stat.ML``, or bare
# archive prefixes like ``physics`` / ``q-bio``. This regex is permissive
# enough to cover all of them while rejecting anything that could smuggle
# operators or whitespace into the search query.
_ARXIV_CAT = re.compile(r"^[a-z][a-z\-]*(\.[A-Z]{2})?$")

_cache: dict[tuple[str, int | None], tuple[float, list[arxiv.Paper]]] = {}


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


async def _fetch_one(cat: str, *, fresh: bool, days: int | None) -> list[arxiv.Paper]:
    now = _time.monotonic()
    cache_key = (cat, days)
    if not fresh:
        entry = _cache.get(cache_key)
        if entry and (now - entry[0]) < CACHE_TTL_S:
            return entry[1]
    query = f"cat:{cat}"
    if days is not None:
        # Push the date filter to arXiv so we don't fetch and discard hundreds
        # of papers we'd then drop client-side. With a 3-day window most
        # categories return well under MAX_PER_CATEGORY, often 5–30 papers.
        query = f"{query} AND {_date_window_clause(days)}"
    result = await arxiv.fetch_recent(
        query, max_results=MAX_PER_CATEGORY, timeout=FETCH_TIMEOUT_S,
    )
    _cache[cache_key] = (now, result)
    return result


async def build(
    categories: Iterable[str], *, fresh: bool, days: int | None = None,
) -> dict:
    """Run the per-category fan-out and return the JSON-ready dict.

    Partial failures are tolerated; whatever came back is returned. The
    failure list lets the SPA show a per-category warning without losing
    the categories that did succeed.

    ``days`` (when set) constrains the arXiv search to the trailing N-day
    window. Without it, we fetch up to ``MAX_PER_CATEGORY`` recent papers
    per category and the SPA filters client-side — fine for "all-time"
    but expensive when the user only wanted the last 3 days.
    """
    cats = tuple(categories)
    results = await asyncio.gather(
        *(_fetch_one(c, fresh=fresh, days=days) for c in cats),
        return_exceptions=True,
    )
    seen: dict[str, arxiv.Paper] = {}
    failures: list[dict] = []
    for cat, res in zip(cats, results):
        if isinstance(res, Exception):
            kind = classify_fetch_error(res)
            log.warning("digest: fetch failed cat:%s kind=%s err=%s", cat, kind, res)
            failures.append({"category": cat, "kind": kind})
            continue
        for p in res:
            seen.setdefault(p.arxiv_id, p)
    items = sorted(seen.values(), key=lambda p: p.published, reverse=True)
    return {
        "count": len(items),
        "papers": [paper_to_dict(p) for p in items],
        "categories": list(cats),
        "failures": failures,
        "days": days,
    }
