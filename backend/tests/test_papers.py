from datetime import datetime, timedelta, timezone

from app import db, papers
from app.arxiv import Paper


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


SAMPLE = Paper(
    arxiv_id="2404.12345",
    title="Test Paper",
    authors="A, B",
    abstract="An abstract.",
    categories="cs.PL",
    published=_iso_days_ago(1),
)


def test_insert_then_get(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    row = papers.get("2404.12345")
    assert row["title"] == "Test Paper"
    assert row["authors"] == "A, B"
    assert row["read_state"] == "unread"


def test_upsert_replaces_existing(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    updated = Paper(**{**SAMPLE.__dict__, "title": "Renamed"})
    papers.upsert([updated])
    assert papers.get("2404.12345")["title"] == "Renamed"


def test_list_recent_returns_in_descending_published_order(atlas_data_dir):
    db.init()
    p1 = Paper(**{**SAMPLE.__dict__, "arxiv_id": "1", "published": _iso_days_ago(2)})
    p2 = Paper(**{**SAMPLE.__dict__, "arxiv_id": "2", "published": _iso_days_ago(1)})
    papers.upsert([p1, p2])
    rows = papers.list_recent(days=7)
    assert [r["arxiv_id"] for r in rows] == ["2", "1"]


def test_get_returns_none_for_missing(atlas_data_dir):
    db.init()
    assert papers.get("does-not-exist") is None
