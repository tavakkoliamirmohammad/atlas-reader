from app import conversations, db, papers
from app.arxiv import Paper


SAMPLE = Paper("1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


def test_append_then_history(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    conversations.append("1", "user", "What is X?")
    conversations.append("1", "assistant", "X is...")

    h = conversations.history("1")
    assert [(r["role"], r["content"]) for r in h] == [
        ("user", "What is X?"),
        ("assistant", "X is..."),
    ]


def test_history_returns_empty_for_unknown_paper(atlas_data_dir):
    db.init()
    assert conversations.history("nope") == []


def test_history_is_per_paper(atlas_data_dir):
    db.init()
    papers.upsert([
        SAMPLE,
        Paper("2", "T2", "A", "x", "cs.PL", "2026-04-19T08:00:00Z"),
    ])
    conversations.append("1", "user", "Q1")
    conversations.append("2", "user", "Q2")

    assert [r["content"] for r in conversations.history("1")] == ["Q1"]
    assert [r["content"] for r in conversations.history("2")] == ["Q2"]
