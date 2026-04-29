from pathlib import Path

import pytest


@pytest.fixture
def atlas_data_dir(monkeypatch, tmp_path):
    """Override ~/.atlas with a temp dir for the duration of the test.

    Also clears ATLAS_PORT / ATLAS_RUNNER_PORT so a sibling test that wrote
    them via `cli.main(["up", "--port", N])` (which sets os.environ directly,
    bypassing monkeypatch) can't leak its choices into this test.

    Resets the in-process digest cache so tests asserting specific
    `fetch_recent` call counts don't see stale entries from earlier tests.
    """
    data_dir = tmp_path / ".atlas"
    data_dir.mkdir()
    (data_dir / "pdfs").mkdir()
    monkeypatch.setenv("ATLAS_DATA_DIR", str(data_dir))
    monkeypatch.delenv("ATLAS_PORT", raising=False)
    monkeypatch.delenv("ATLAS_RUNNER_PORT", raising=False)
    # The digest cache lives in process memory now (no SQLite cache table).
    # Wipe it between tests so cached entries from a prior test don't bleed
    # into await-count assertions in the next one.
    try:
        from app import digest as _digest
        _digest.clear_cache()
    except Exception:  # pragma: no cover — module may not be importable yet
        pass
    return data_dir


@pytest.fixture
def fixtures_dir():
    """Path to test fixtures directory."""
    return Path(__file__).parent / "fixtures"
