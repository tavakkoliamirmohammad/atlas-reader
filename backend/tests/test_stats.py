from datetime import datetime, timedelta, timezone

from app import db, stats


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log(arxiv_id: str, when: datetime) -> None:
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO events (ts, event, arxiv_id) VALUES (?, ?, ?)",
            (_iso(when), "paper_open", arxiv_id),
        )


def test_record_open_inserts_event(atlas_data_dir):
    db.init()
    stats.record_open("2404.12345")
    with db.connect() as conn:
        rows = list(conn.execute("SELECT event, arxiv_id FROM events"))
    assert len(rows) == 1
    assert rows[0]["event"] == "paper_open"
    assert rows[0]["arxiv_id"] == "2404.12345"


def test_papers_today_counts_unique_arxiv_ids_for_current_utc_day(atlas_data_dir):
    db.init()
    now = datetime.now(timezone.utc)
    _log("a", now)
    _log("a", now)
    _log("b", now)
    _log("c", now - timedelta(days=2))
    assert stats.papers_today() == 2


def test_total_papers_counts_unique_arxiv_ids_across_all_time(atlas_data_dir):
    db.init()
    now = datetime.now(timezone.utc)
    _log("a", now)
    _log("b", now - timedelta(days=5))
    _log("a", now - timedelta(days=10))
    assert stats.total_papers() == 2


def test_streak_days_returns_zero_when_no_events(atlas_data_dir):
    db.init()
    assert stats.streak_days() == 0


def test_streak_days_counts_consecutive_days_back_from_today(atlas_data_dir):
    db.init()
    now = datetime.now(timezone.utc)
    for i in range(5):
        _log(f"p{i}", now - timedelta(days=i))
    assert stats.streak_days() == 5


def test_streak_days_breaks_on_missing_day(atlas_data_dir):
    db.init()
    now = datetime.now(timezone.utc)
    _log("p0", now)
    _log("p1", now - timedelta(days=1))
    _log("p3", now - timedelta(days=3))
    assert stats.streak_days() == 2


def test_streak_days_allows_gap_before_today_if_yesterday_present(atlas_data_dir):
    db.init()
    now = datetime.now(timezone.utc)
    _log("p1", now - timedelta(days=1))
    _log("p2", now - timedelta(days=2))
    assert stats.streak_days() == 2


def test_summary_returns_all_three_fields(atlas_data_dir):
    db.init()
    now = datetime.now(timezone.utc)
    _log("a", now)
    _log("b", now - timedelta(days=1))
    out = stats.summary()
    assert out == {"streak_days": 2, "total_papers": 2, "papers_today": 1}
