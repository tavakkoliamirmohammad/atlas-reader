from datetime import datetime, timedelta, timezone
import shutil

from app import conversations, db, papers
from app.arxiv import Paper


SAMPLE = Paper("1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")


def _seed(arxiv_id: str, role: str, content: str, created_at: str | None = None) -> None:
    """Insert a row with a custom created_at (for retention-sweep tests)."""
    with db.connect() as conn:
        if created_at is None:
            conn.execute(
                "INSERT INTO conversations (arxiv_id, role, content) VALUES (?, ?, ?)",
                (arxiv_id, role, content),
            )
        else:
            conn.execute(
                "INSERT INTO conversations (arxiv_id, role, content, created_at) "
                "VALUES (?, ?, ?, ?)",
                (arxiv_id, role, content, created_at),
            )


def test_append_then_history(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    conversations.append("1", "user", "What is X?")
    conversations.append("1", "assistant", "X is...", model="gpt-5.4")

    h = conversations.history("1")
    assert [(r["role"], r["content"], r["model"]) for r in h] == [
        ("user", "What is X?", None),
        ("assistant", "X is...", "gpt-5.4"),
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


def test_clear_removes_all_messages_for_paper(atlas_data_dir):
    db.init()
    papers.upsert([
        SAMPLE,
        Paper("2", "T2", "A", "x", "cs.PL", "2026-04-19T08:00:00Z"),
    ])
    conversations.append("1", "user", "q1")
    conversations.append("1", "assistant", "a1")
    conversations.append("2", "user", "untouched")

    removed = conversations.clear("1")
    assert removed == 2
    assert conversations.history("1") == []
    assert len(conversations.history("2")) == 1    # other paper intact


def test_prune_older_than_drops_only_old_rows(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    now = datetime.now(timezone.utc)
    old_ts = (now - timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent_ts = (now - timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    _seed("1", "user", "old", old_ts)
    _seed("1", "user", "recent", recent_ts)

    deleted = conversations.prune_older_than(30)
    assert deleted == 1
    remaining = conversations.history("1")
    assert [r["content"] for r in remaining] == ["recent"]


def test_prune_older_than_zero_or_negative_is_noop(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    conversations.append("1", "user", "hi")
    assert conversations.prune_older_than(0) == 0
    assert conversations.prune_older_than(-5) == 0
    assert len(conversations.history("1")) == 1


def test_prune_orphan_pdfs_removes_files_without_paper_rows(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    pdfs = db.data_dir() / "pdfs"
    pdfs.mkdir(parents=True, exist_ok=True)
    kept = pdfs / "1.pdf"
    orphan1 = pdfs / "ghost-123.pdf"
    orphan2 = pdfs / "custom-abcdef.pdf"
    for p in (kept, orphan1, orphan2):
        p.write_bytes(b"%PDF-1.4\n")

    removed = conversations.prune_orphan_pdfs()
    assert removed == 2
    assert kept.exists()
    assert not orphan1.exists() and not orphan2.exists()


def test_prune_orphan_pdfs_handles_missing_dir(atlas_data_dir):
    db.init()
    pdfs = db.data_dir() / "pdfs"
    if pdfs.exists():
        shutil.rmtree(pdfs)
    assert conversations.prune_orphan_pdfs() == 0
