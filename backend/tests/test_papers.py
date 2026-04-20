from app import db, papers
from app.arxiv import Paper


SAMPLE = Paper(
    arxiv_id="2404.12345",
    title="Test Paper",
    authors="A, B",
    abstract="An abstract.",
    categories="cs.PL",
    published="2026-04-18T08:00:00Z",
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
    p1 = Paper(**{**SAMPLE.__dict__, "arxiv_id": "1", "published": "2026-04-17T08:00:00Z"})
    p2 = Paper(**{**SAMPLE.__dict__, "arxiv_id": "2", "published": "2026-04-18T08:00:00Z"})
    papers.upsert([p1, p2])
    rows = papers.list_recent(days=7)
    assert [r["arxiv_id"] for r in rows] == ["2", "1"]


def test_get_returns_none_for_missing(atlas_data_dir):
    db.init()
    assert papers.get("does-not-exist") is None
