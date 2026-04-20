"""Build today's digest: fetch arXiv, dedupe, persist. AI ranking added in Plan 3."""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timezone

from app import arxiv, db, papers


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


def _record_build(status: str, paper_count: int = 0, log: str = "") -> None:
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO builds (date, status, started_at, finished_at, paper_count, log)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(date) DO UPDATE SET
                 status=excluded.status,
                 finished_at=excluded.finished_at,
                 paper_count=excluded.paper_count,
                 log=excluded.log""",
            (_today_iso(), status, _now_iso(), _now_iso(), paper_count, log),
        )


async def build_today() -> list[sqlite3.Row]:
    """Fetch both arXiv queries, dedupe, persist, and return the row set."""
    pl = await arxiv.fetch_recent(PL_QUERY, max_results=100)
    other = await arxiv.fetch_recent(KEYWORD_QUERY, max_results=30)

    seen: dict[str, arxiv.Paper] = {}
    for p in (*pl, *other):
        seen.setdefault(p.arxiv_id, p)

    papers.upsert(list(seen.values()))
    rows = papers.list_recent(days=3)
    _record_build(status="done", paper_count=len(seen))
    return rows
