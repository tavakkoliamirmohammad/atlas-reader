"""Tests for the on-disk cleanup sweep (TTL prune for podcast audio)."""

from __future__ import annotations

import os
import time

import pytest

from app import cleanup, db


def _touch(p, *, age_days: float) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")
    target = time.time() - age_days * 86400
    os.utime(p, (target, target))


@pytest.fixture(autouse=True)
def _reset_throttle():
    """Each test starts from a clean throttle state so call ordering doesn't matter."""
    cleanup._last_run = 0.0
    yield
    cleanup._last_run = 0.0


def test_prunes_old_podcast_pair_and_removes_empty_dir(atlas_data_dir):
    db.init()
    paper_dir = atlas_data_dir / "podcasts" / "2401.00001"
    _touch(paper_dir / "short.mp3", age_days=45)
    _touch(paper_dir / "short.json", age_days=45)

    counts = cleanup.sweep(force=True)
    assert counts["podcast_files"] == 2
    assert not paper_dir.exists()  # empty dir is cleaned up


def test_keeps_fresh_podcast_pair(atlas_data_dir):
    db.init()
    paper_dir = atlas_data_dir / "podcasts" / "2401.00002"
    _touch(paper_dir / "long.mp3", age_days=1)
    _touch(paper_dir / "long.json", age_days=1)

    counts = cleanup.sweep(force=True)
    assert counts["podcast_files"] == 0
    assert (paper_dir / "long.mp3").exists()
    assert (paper_dir / "long.json").exists()


def test_pair_atomicity_prunes_both_when_either_is_old(atlas_data_dir):
    """If the .json got modified yesterday but the .mp3 is 45 days old,
    both should still go — we never want a half-pair to stay around."""
    db.init()
    paper_dir = atlas_data_dir / "podcasts" / "2401.00003"
    _touch(paper_dir / "medium.mp3", age_days=45)
    _touch(paper_dir / "medium.json", age_days=1)

    counts = cleanup.sweep(force=True)
    assert counts["podcast_files"] == 2
    assert not (paper_dir / "medium.mp3").exists()
    assert not (paper_dir / "medium.json").exists()


def test_throttle_skips_back_to_back_calls(atlas_data_dir, monkeypatch):
    """Second call within the throttle window is a no-op even if files would qualify."""
    db.init()
    paper_dir = atlas_data_dir / "podcasts" / "2401.00004"
    _touch(paper_dir / "short.mp3", age_days=45)
    _touch(paper_dir / "short.json", age_days=45)

    # Allow first call through, then ensure the second is throttled.
    cleanup.sweep(force=True)

    # Re-create files; a non-forced call should still skip.
    _touch(paper_dir / "short.mp3", age_days=45)
    _touch(paper_dir / "short.json", age_days=45)
    counts = cleanup.sweep(force=False)
    assert counts == {"skipped": 1}
    assert (paper_dir / "short.mp3").exists()


def test_force_overrides_throttle(atlas_data_dir):
    db.init()
    paper_dir = atlas_data_dir / "podcasts" / "2401.00005"
    _touch(paper_dir / "short.mp3", age_days=45)
    _touch(paper_dir / "short.json", age_days=45)

    cleanup.sweep(force=True)  # warm up the throttle
    _touch(paper_dir / "short.mp3", age_days=45)
    _touch(paper_dir / "short.json", age_days=45)
    counts = cleanup.sweep(force=True)
    assert counts.get("podcast_files", 0) == 2


def test_retention_env_overrides_default(atlas_data_dir, monkeypatch):
    db.init()
    paper_dir = atlas_data_dir / "podcasts" / "2401.00006"
    _touch(paper_dir / "long.mp3", age_days=10)
    _touch(paper_dir / "long.json", age_days=10)

    monkeypatch.setenv("ATLAS_PODCAST_RETENTION_DAYS", "5")
    counts = cleanup.sweep(force=True)
    assert counts["podcast_files"] == 2


def test_missing_podcasts_dir_is_a_noop(atlas_data_dir):
    db.init()
    assert not (atlas_data_dir / "podcasts").exists()
    counts = cleanup.sweep(force=True)
    assert counts.get("podcast_files", 0) == 0
