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


def test_default_thread_id_is_one(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    conversations.append("1", "user", "Q")

    rows = conversations.history("1")
    assert rows[0]["thread_id"] == 1


def test_history_filters_by_thread(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    conversations.append("1", "user", "thread-1 message")
    conversations.append("1", "user", "thread-2 message", thread_id=2)

    h1 = conversations.history("1", thread_id=1)
    h2 = conversations.history("1", thread_id=2)
    assert [r["content"] for r in h1] == ["thread-1 message"]
    assert [r["content"] for r in h2] == ["thread-2 message"]


def test_create_thread_returns_id_and_appears_in_list(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    new_id = conversations.create_thread("1", title="Side question")
    assert new_id != 1

    threads = conversations.list_threads("1")
    titles = [t["title"] for t in threads]
    assert "Side question" in titles


def test_list_threads_includes_synthetic_default(atlas_data_dir):
    """Even with no rows in the threads table, the default thread should appear."""
    db.init()
    papers.upsert([SAMPLE])
    threads = conversations.list_threads("1")
    assert len(threads) >= 1
    assert threads[0]["id"] == 1
