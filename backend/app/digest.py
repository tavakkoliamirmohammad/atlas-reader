"""Build today's digest: fetch arXiv, dedupe, persist. AI ranking added in Plan 3."""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timezone

from app import ai_backend, arxiv, db, health, papers, ranker


# Mirrors ~/.claude/compiler-papers.sh
PL_QUERY = "cat:cs.PL"
KEYWORD_QUERY = (
    '(cat:cs.AR OR cat:cs.DC) AND '
    '(all:compiler OR all:MLIR OR all:LLVM OR all:"code generation" '
    'OR all:DSL OR all:"intermediate representation" '
    'OR all:"tensor compiler" OR all:"kernel optimization" '
    'OR all:autotuning OR all:polyhedral OR all:vectorization '
    'OR all:"loop optimization" OR all:tiling OR all:scheduling '
    'OR all:dataflow OR all:HLS OR all:"hardware synthesis" '
    'OR all:"instruction selection")'
)


def _today_iso() -> str:
    return date.today().isoformat()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _start_build() -> None:
    """Insert a 'building' row at start time, or reset finish/log on retry."""
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO builds (date, status, started_at, finished_at, paper_count, log)
               VALUES (?, 'building', ?, NULL, 0, '')
               ON CONFLICT(date) DO UPDATE SET
                 status='building',
                 started_at=excluded.started_at,
                 finished_at=NULL,
                 paper_count=0,
                 log=''""",
            (_today_iso(), _now_iso()),
        )


def _finish_build(status: str, paper_count: int = 0, log: str = "") -> None:
    """Update today's build row with the terminal status."""
    with db.connect() as conn:
        conn.execute(
            """UPDATE builds
                 SET status = ?, finished_at = ?, paper_count = ?, log = ?
               WHERE date = ?""",
            (status, _now_iso(), paper_count, log, _today_iso()),
        )


async def build_today(
    backend: str = ai_backend.DEFAULT_BACKEND,
    rank: bool = True,
) -> list[sqlite3.Row]:
    """Fetch both arXiv queries, dedupe, persist, and return the row set.

    When `rank` is True and the chosen backend's CLI is available, also runs
    the AI ranker on all papers. Set `rank=False` to return as soon as the
    arXiv fetch completes — useful when the caller wants the paper list fast
    and does not care about AI tier ordering.

    Ranker failures are logged but never block the build.
    """
    _start_build()
    try:
        pl = await arxiv.fetch_recent(PL_QUERY, max_results=100)
        other = await arxiv.fetch_recent(KEYWORD_QUERY, max_results=30)
    except Exception as e:
        # arXiv throttle / timeout / network flap. Don't propagate to the UI —
        # return whatever is already cached in the DB so the list still loads.
        import logging
        logging.getLogger(__name__).warning("arxiv fetch failed: %s: %s", type(e).__name__, e)
        _finish_build(status="failed", log=f"{type(e).__name__}: {e}")
        return papers.list_recent(days=7)

    seen: dict[str, arxiv.Paper] = {}
    for p in (*pl, *other):
        seen.setdefault(p.arxiv_id, p)

    papers.upsert(list(seen.values()))
    if rank and health.backend_available(backend):
        try:
            await ranker.score_papers(list(seen.values()), backend=backend)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("ranker failed: %s", exc)
    rows = papers.list_recent(days=7)
    _finish_build(status="done", paper_count=len(seen))
    return rows
