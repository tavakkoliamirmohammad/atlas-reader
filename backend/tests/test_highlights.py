import pytest
from httpx import ASGITransport, AsyncClient

from app import db, highlights, papers
from app.arxiv import Paper
from app.main import app


SAMPLE = Paper("hl1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


# --- repository ---


def test_add_returns_id_and_round_trips(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    new_id = highlights.add("hl1", "an important quote", color="coral", page=3)
    assert new_id > 0

    rows = highlights.list_for("hl1")
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == new_id
    assert row["quote"] == "an important quote"
    assert row["color"] == "coral"
    assert row["page"] == 3
    assert row["note"] is None


def test_default_color_is_yellow(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    highlights.add("hl1", "q")
    rows = highlights.list_for("hl1")
    assert rows[0]["color"] == "yellow"


def test_list_for_unknown_paper_is_empty(atlas_data_dir):
    db.init()
    assert highlights.list_for("nope") == []


def test_list_for_orders_newest_first(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    a = highlights.add("hl1", "first")
    b = highlights.add("hl1", "second")
    rows = highlights.list_for("hl1")
    assert [r["id"] for r in rows] == [b, a]


def test_delete_removes_row_and_returns_true(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    new_id = highlights.add("hl1", "to delete")
    assert highlights.delete(new_id) is True
    assert highlights.list_for("hl1") == []


def test_delete_unknown_returns_false(atlas_data_dir):
    db.init()
    assert highlights.delete(99999) is False


def test_highlights_are_per_paper(atlas_data_dir):
    db.init()
    papers.upsert([
        SAMPLE,
        Paper("hl2", "T2", "A", "x", "cs.PL", "2026-04-19T08:00:00Z"),
    ])
    highlights.add("hl1", "for paper 1")
    highlights.add("hl2", "for paper 2")
    assert [r["quote"] for r in highlights.list_for("hl1")] == ["for paper 1"]
    assert [r["quote"] for r in highlights.list_for("hl2")] == ["for paper 2"]


# --- HTTP endpoints ---


@pytest.mark.asyncio
async def test_post_highlight_creates_and_get_lists(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        cr = await c.post(
            "/api/highlights/hl1",
            json={"quote": "key insight", "color": "blue", "page": 4},
        )
        assert cr.status_code == 200
        new_id = cr.json()["id"]
        assert isinstance(new_id, int) and new_id > 0

        lr = await c.get("/api/highlights/hl1")

    assert lr.status_code == 200
    rows = lr.json()["highlights"]
    assert len(rows) == 1
    assert rows[0]["quote"] == "key insight"
    assert rows[0]["color"] == "blue"
    assert rows[0]["page"] == 4
    assert rows[0]["id"] == new_id


@pytest.mark.asyncio
async def test_post_highlight_404_for_unknown_paper(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/highlights/missing", json={"quote": "q"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_post_highlight_rejects_blank_quote(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/highlights/hl1", json={"quote": "   "})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_get_highlights_empty_for_unknown_paper(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/highlights/nobody")
    assert r.status_code == 200
    assert r.json() == {"highlights": []}


@pytest.mark.asyncio
async def test_delete_highlight_returns_204(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    new_id = highlights.add("hl1", "bye")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        dr = await c.delete(f"/api/highlights/{new_id}")
        assert dr.status_code == 204

        lr = await c.get("/api/highlights/hl1")

    assert lr.json()["highlights"] == []


@pytest.mark.asyncio
async def test_delete_highlight_404_when_unknown(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.delete("/api/highlights/424242")
    assert r.status_code == 404
