"""Reading stats: streak, total papers opened, papers opened today."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import db


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _today_utc() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)


def record_open(arxiv_id: str) -> None:
    """Write a paper_open event."""
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO events (ts, event, arxiv_id) VALUES (?, ?, ?)",
            (_now_iso(), "paper_open", arxiv_id),
        )


def _distinct_arxiv_on(day: datetime) -> set[str]:
    start = day.strftime("%Y-%m-%dT00:00:00Z")
    end = (day + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT DISTINCT arxiv_id FROM events "
            "WHERE event='paper_open' AND ts >= ? AND ts < ? AND arxiv_id IS NOT NULL",
            (start, end),
        )
        return {row["arxiv_id"] for row in cur.fetchall()}


def papers_today() -> int:
    return len(_distinct_arxiv_on(_today_utc()))


def total_papers() -> int:
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT COUNT(DISTINCT arxiv_id) AS c FROM events "
            "WHERE event='paper_open' AND arxiv_id IS NOT NULL"
        )
        return int(cur.fetchone()["c"])


def streak_days() -> int:
    """Count consecutive days (up to today) with at least one paper_open event.

    Allows today empty if yesterday is present (then counts back from yesterday).
    """
    today = _today_utc()
    if _distinct_arxiv_on(today):
        cursor = today
    elif _distinct_arxiv_on(today - timedelta(days=1)):
        cursor = today - timedelta(days=1)
    else:
        return 0

    count = 0
    while _distinct_arxiv_on(cursor):
        count += 1
        cursor -= timedelta(days=1)
    return count


def summary() -> dict:
    return {
        "streak_days": streak_days(),
        "total_papers": total_papers(),
        "papers_today": papers_today(),
    }
