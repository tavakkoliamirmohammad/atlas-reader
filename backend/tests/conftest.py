from pathlib import Path

import pytest


@pytest.fixture
def atlas_data_dir(monkeypatch, tmp_path):
    """Override ~/.atlas with a temp dir for the duration of the test."""
    data_dir = tmp_path / ".atlas"
    data_dir.mkdir()
    (data_dir / "pdfs").mkdir()
    monkeypatch.setenv("ATLAS_DATA_DIR", str(data_dir))
    return data_dir


@pytest.fixture
def fixtures_dir():
    """Path to test fixtures directory."""
    return Path(__file__).parent / "fixtures"
