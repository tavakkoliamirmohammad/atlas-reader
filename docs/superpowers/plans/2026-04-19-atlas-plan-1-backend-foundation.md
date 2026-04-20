# Atlas Plan 1 — Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A FastAPI server running on `localhost:8765` that exposes a SQLite-backed paper database, fetches recent arXiv papers in the user's research areas, caches PDFs locally, reports whether the local `claude` CLI is available, and ships a small `atlas` CLI for ops. No frontend, no AI calls yet — just the data plane.

**Architecture:** Single FastAPI app launched via `uvicorn`. Persistence is SQLite via the stdlib `sqlite3` module (no ORM). Outbound HTTP (arXiv API + PDF downloads) uses `httpx`. arXiv responses are parsed with stdlib `xml.etree.ElementTree`. Tests are pytest with `pytest-asyncio` and `httpx.AsyncClient` for FastAPI integration.

**Tech Stack:** Python 3.12+, FastAPI, uvicorn, httpx, pytest, pytest-asyncio, sqlite3 (stdlib), xml.etree.ElementTree (stdlib). The `claude` CLI is invoked only via subprocess; no `anthropic` SDK dependency.

---

## File Structure

```
paper-dashboard/
├── pyproject.toml                  ← project metadata + deps + atlas entry point
├── README.md                       ← brief setup + run instructions
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                 ← FastAPI app, lifespan, route mounting
│   │   ├── db.py                   ← SQLite schema + connection helpers
│   │   ├── arxiv.py                ← arXiv API client (fetch + parse)
│   │   ├── papers.py               ← Paper repository (insert/get/list/dedup)
│   │   ├── pdf_cache.py            ← PDF download + on-disk cache
│   │   ├── health.py               ← claude availability detection
│   │   ├── digest.py               ← today's digest assembly
│   │   ├── cli.py                  ← `atlas` CLI entry point
│   │   └── prompts/
│   │       └── ranker.txt          ← (placeholder — used in Plan 3)
│   └── tests/
│       ├── conftest.py             ← shared pytest fixtures
│       ├── fixtures/
│       │   ├── arxiv_sample.xml    ← canned arXiv API response for testing
│       │   └── tiny.pdf            ← canned PDF for testing
│       ├── test_db.py
│       ├── test_arxiv.py
│       ├── test_papers.py
│       ├── test_pdf_cache.py
│       ├── test_health.py
│       ├── test_digest.py
│       ├── test_main.py
│       └── test_cli.py
```

**Responsibilities (one file = one job):**
- `db.py` knows about the schema and how to connect; nothing else
- `arxiv.py` only fetches and parses; never touches the database
- `papers.py` is the only module that reads/writes paper rows
- `pdf_cache.py` owns the on-disk PDF cache
- `digest.py` orchestrates the above to produce today's digest
- `health.py` is a single function that returns `True/False` for AI availability
- `main.py` wires HTTP routes to the modules above

Data lives at `~/.atlas/`:
- `~/.atlas/atlas.db` — SQLite file
- `~/.atlas/pdfs/{arxiv_id}.pdf` — cached PDFs

Configurable via `ATLAS_DATA_DIR` env var (tests override this to a temp dir).

---

## Task 1: Project bootstrap

**Files:**
- Create: `pyproject.toml`
- Create: `README.md`
- Create: `backend/app/__init__.py`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/conftest.py`

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[project]
name = "atlas"
version = "0.1.0"
description = "Local-first paper reviewer with on-demand AI features"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.110",
    "uvicorn[standard]>=0.27",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = [
    "pytest>=8",
    "pytest-asyncio>=0.23",
]

[project.scripts]
atlas = "app.cli:main"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["backend"]
include = ["app*"]

[tool.pytest.ini_options]
testpaths = ["backend/tests"]
pythonpath = ["backend"]
asyncio_mode = "auto"
```

- [ ] **Step 2: Create empty `__init__.py` files**

```bash
mkdir -p backend/app backend/app/prompts backend/tests backend/tests/fixtures
touch backend/app/__init__.py
touch backend/tests/__init__.py
touch backend/app/prompts/ranker.txt
```

- [ ] **Step 3: Create `README.md`**

```markdown
# Atlas

Local-first paper reviewer. Reads arXiv papers, summarizes on-demand using your Claude subscription.

## Setup

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Run the dev server

```bash
atlas start          # launches uvicorn on http://localhost:8765
atlas stop
atlas status
```

## Run tests

```bash
pytest
```
```

- [ ] **Step 4: Create `backend/tests/conftest.py` with shared fixtures**

```python
import os
import tempfile
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
```

- [ ] **Step 5: Verify install works**

```bash
python3.12 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
```

Expected: installs without error; `pytest --collect-only` runs cleanly (no tests collected yet).

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml README.md backend/
git commit -m "chore: bootstrap atlas backend project"
```

---

## Task 2: SQLite schema and connection helpers

**Files:**
- Create: `backend/app/db.py`
- Create: `backend/tests/test_db.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_db.py`:

```python
from pathlib import Path

import pytest

from app import db


def test_init_creates_database_file(atlas_data_dir):
    db.init()
    assert (atlas_data_dir / "atlas.db").exists()


def test_init_is_idempotent(atlas_data_dir):
    db.init()
    db.init()  # should not raise
    assert (atlas_data_dir / "atlas.db").exists()


def test_connect_returns_working_connection(atlas_data_dir):
    db.init()
    with db.connect() as conn:
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row[0] for row in cursor}
    assert "papers" in tables
    assert "builds" in tables
    assert "conversations" in tables
    assert "prefs" in tables


def test_papers_schema_has_expected_columns(atlas_data_dir):
    db.init()
    with db.connect() as conn:
        cursor = conn.execute("PRAGMA table_info(papers)")
        columns = {row[1] for row in cursor}
    assert {"arxiv_id", "title", "authors", "abstract", "categories",
            "published", "pdf_path", "ai_tier", "ai_score", "read_state"} <= columns
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_db.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.db'`.

- [ ] **Step 3: Implement `backend/app/db.py`**

```python
"""SQLite schema and connection helpers for Atlas."""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    arxiv_id    TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    authors     TEXT NOT NULL,
    abstract    TEXT NOT NULL,
    categories  TEXT NOT NULL,
    published   TEXT NOT NULL,
    pdf_path    TEXT,
    ai_tier     INTEGER,
    ai_score    REAL,
    read_state  TEXT NOT NULL DEFAULT 'unread'
);

CREATE TABLE IF NOT EXISTS builds (
    date         TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT,
    paper_count  INTEGER,
    log          TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    arxiv_id    TEXT NOT NULL REFERENCES papers(arxiv_id),
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prefs (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_published ON papers(published);
CREATE INDEX IF NOT EXISTS idx_conv_arxiv      ON conversations(arxiv_id);
"""


def data_dir() -> Path:
    """Return the active data directory, honoring ATLAS_DATA_DIR."""
    p = Path(os.environ.get("ATLAS_DATA_DIR", str(Path.home() / ".atlas")))
    p.mkdir(parents=True, exist_ok=True)
    (p / "pdfs").mkdir(exist_ok=True)
    return p


def db_path() -> Path:
    return data_dir() / "atlas.db"


def init() -> None:
    """Create the database file and all tables if they don't exist."""
    with sqlite3.connect(db_path()) as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Yield a connection with row_factory set; auto-commits on exit."""
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_db.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/db.py backend/tests/test_db.py
git commit -m "feat(db): SQLite schema and connection helpers"
```

---

## Task 3: arXiv client — parse a single entry

**Files:**
- Create: `backend/app/arxiv.py`
- Create: `backend/tests/test_arxiv.py`
- Create: `backend/tests/fixtures/arxiv_sample.xml`

- [ ] **Step 1: Create test fixture `backend/tests/fixtures/arxiv_sample.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2404.12345v1</id>
    <updated>2026-04-18T12:00:00Z</updated>
    <published>2026-04-18T08:00:00Z</published>
    <title>SPIRV-LLVM-Bridge: Unified Codegen for GPU Kernels</title>
    <summary>Modern accelerator stacks fragment GPU code generation across
    multiple intermediate representations.</summary>
    <author><name>Lin Chen</name></author>
    <author><name>Soyoung Park</name></author>
    <author><name>Wei Liu</name></author>
    <category term="cs.PL" />
    <category term="cs.AR" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2404.99999v2</id>
    <updated>2026-04-17T10:00:00Z</updated>
    <published>2026-04-17T09:00:00Z</published>
    <title>Affine Map Composition in MLIR Linalg</title>
    <summary>We introduce a calculus for composing affine maps.</summary>
    <author><name>Priya Singh</name></author>
    <category term="cs.PL" />
  </entry>
</feed>
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_arxiv.py`:

```python
from app import arxiv


def test_parse_returns_paper_dataclasses(fixtures_dir):
    xml_text = (fixtures_dir / "arxiv_sample.xml").read_text()
    papers = arxiv.parse_feed(xml_text)
    assert len(papers) == 2

    p = papers[0]
    assert p.arxiv_id == "2404.12345"  # version stripped
    assert p.title == "SPIRV-LLVM-Bridge: Unified Codegen for GPU Kernels"
    assert p.authors == "Lin Chen, Soyoung Park, Wei Liu"
    assert p.abstract.startswith("Modern accelerator stacks fragment")
    assert p.categories == "cs.PL, cs.AR"
    assert p.published == "2026-04-18T08:00:00Z"


def test_parse_collapses_whitespace_in_title_and_abstract(fixtures_dir):
    xml_text = (fixtures_dir / "arxiv_sample.xml").read_text()
    papers = arxiv.parse_feed(xml_text)
    assert "\n" not in papers[0].title
    assert "\n" not in papers[0].abstract


def test_parse_empty_feed_returns_empty_list():
    xml_text = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"/>'
    assert arxiv.parse_feed(xml_text) == []
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest backend/tests/test_arxiv.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.arxiv'`.

- [ ] **Step 4: Implement parsing in `backend/app/arxiv.py`**

```python
"""arXiv API client: fetch recent papers and parse the Atom response."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List


_NS = {"atom": "http://www.w3.org/2005/Atom"}
_WS = re.compile(r"\s+")


@dataclass(frozen=True)
class Paper:
    arxiv_id: str
    title: str
    authors: str        # comma-joined
    abstract: str
    categories: str     # comma-joined
    published: str      # ISO-8601


def _clean(text: str | None) -> str:
    return _WS.sub(" ", (text or "")).strip()


def _arxiv_id_from_url(url: str) -> str:
    """http://arxiv.org/abs/2404.12345v1 -> 2404.12345"""
    last = url.rsplit("/", 1)[-1]
    return last.split("v")[0]


def parse_feed(xml_text: str) -> List[Paper]:
    """Parse an arXiv Atom feed into a list of Paper records."""
    root = ET.fromstring(xml_text)
    out: list[Paper] = []
    for entry in root.findall("atom:entry", _NS):
        link_el = entry.find("atom:id", _NS)
        if link_el is None or not link_el.text:
            continue
        out.append(
            Paper(
                arxiv_id=_arxiv_id_from_url(link_el.text),
                title=_clean(entry.findtext("atom:title", default="", namespaces=_NS)),
                authors=", ".join(
                    _clean(a.findtext("atom:name", default="", namespaces=_NS))
                    for a in entry.findall("atom:author", _NS)
                ),
                abstract=_clean(entry.findtext("atom:summary", default="", namespaces=_NS)),
                categories=", ".join(
                    c.get("term", "") for c in entry.findall("atom:category", _NS)
                ),
                published=_clean(
                    entry.findtext("atom:published", default="", namespaces=_NS)
                ),
            )
        )
    return out
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest backend/tests/test_arxiv.py -v`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/app/arxiv.py backend/tests/test_arxiv.py backend/tests/fixtures/arxiv_sample.xml
git commit -m "feat(arxiv): parse arXiv Atom feed into Paper records"
```

---

## Task 4: arXiv client — fetch from the live API

**Files:**
- Modify: `backend/app/arxiv.py`
- Modify: `backend/tests/test_arxiv.py`

- [ ] **Step 1: Add the failing fetch test**

Append to `backend/tests/test_arxiv.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch

from app import arxiv


@pytest.mark.asyncio
async def test_fetch_recent_calls_arxiv_api(fixtures_dir):
    xml_text = (fixtures_dir / "arxiv_sample.xml").read_text()
    fake_response = AsyncMock()
    fake_response.text = xml_text
    fake_response.raise_for_status = lambda: None

    with patch("app.arxiv.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.get = AsyncMock(return_value=fake_response)

        papers = await arxiv.fetch_recent(query="cat:cs.PL", max_results=10)

    assert len(papers) == 2
    args, kwargs = instance.get.call_args
    assert args[0] == "https://export.arxiv.org/api/query"
    assert kwargs["params"]["search_query"] == "cat:cs.PL"
    assert kwargs["params"]["max_results"] == "10"
    assert kwargs["params"]["sortBy"] == "submittedDate"
    assert kwargs["params"]["sortOrder"] == "descending"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_arxiv.py::test_fetch_recent_calls_arxiv_api -v`
Expected: FAIL with `AttributeError: module 'app.arxiv' has no attribute 'fetch_recent'`.

- [ ] **Step 3: Add `fetch_recent` to `backend/app/arxiv.py`**

Add at top of file:
```python
import httpx
```

Append to file:

```python
ARXIV_ENDPOINT = "https://export.arxiv.org/api/query"


async def fetch_recent(query: str, max_results: int = 100, timeout: float = 30.0) -> List[Paper]:
    """Hit the arXiv API and parse the response. `query` is an arXiv search_query string."""
    params = {
        "search_query": query,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "max_results": str(max_results),
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(ARXIV_ENDPOINT, params=params)
        resp.raise_for_status()
        return parse_feed(resp.text)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_arxiv.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/arxiv.py backend/tests/test_arxiv.py
git commit -m "feat(arxiv): async fetch from arXiv API"
```

---

## Task 5: Paper repository (insert/get/list)

**Files:**
- Create: `backend/app/papers.py`
- Create: `backend/tests/test_papers.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_papers.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_papers.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.papers'`.

- [ ] **Step 3: Implement `backend/app/papers.py`**

```python
"""Paper repository: the only module that reads/writes the papers table."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from typing import Iterable, Optional

from app import db
from app.arxiv import Paper


def upsert(items: Iterable[Paper]) -> int:
    """Insert or replace paper rows. Returns number of rows written."""
    rows = [
        (p.arxiv_id, p.title, p.authors, p.abstract, p.categories, p.published)
        for p in items
    ]
    with db.connect() as conn:
        conn.executemany(
            """INSERT INTO papers
                 (arxiv_id, title, authors, abstract, categories, published)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(arxiv_id) DO UPDATE SET
                 title=excluded.title,
                 authors=excluded.authors,
                 abstract=excluded.abstract,
                 categories=excluded.categories,
                 published=excluded.published""",
            rows,
        )
    return len(rows)


def get(arxiv_id: str) -> Optional[sqlite3.Row]:
    with db.connect() as conn:
        cur = conn.execute("SELECT * FROM papers WHERE arxiv_id = ?", (arxiv_id,))
        return cur.fetchone()


def list_recent(days: int = 1) -> list[sqlite3.Row]:
    """Return papers published within the last `days` days, newest first."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with db.connect() as conn:
        cur = conn.execute(
            "SELECT * FROM papers WHERE published >= ? ORDER BY published DESC",
            (cutoff,),
        )
        return list(cur.fetchall())


def set_pdf_path(arxiv_id: str, path: str) -> None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE papers SET pdf_path = ? WHERE arxiv_id = ?", (path, arxiv_id)
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_papers.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/papers.py backend/tests/test_papers.py
git commit -m "feat(papers): repository for inserting and querying paper rows"
```

---

## Task 6: PDF cache module

**Files:**
- Create: `backend/app/pdf_cache.py`
- Create: `backend/tests/test_pdf_cache.py`
- Create: `backend/tests/fixtures/tiny.pdf` (any small valid PDF — we'll generate one)

- [ ] **Step 1: Generate the tiny test PDF fixture**

```bash
python3.12 -c "
import zlib, struct
# Minimal valid PDF: one empty page
pdf = b'''%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>> endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000095 00000 n
trailer <</Size 4 /Root 1 0 R>>
startxref
148
%%EOF'''
open('backend/tests/fixtures/tiny.pdf', 'wb').write(pdf)
"
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_pdf_cache.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch

from app import db, pdf_cache, papers
from app.arxiv import Paper


SAMPLE = Paper(
    arxiv_id="2404.12345",
    title="t", authors="a", abstract="x", categories="cs.PL",
    published="2026-04-18T08:00:00Z",
)


def test_cache_path_returns_data_dir_pdf_path(atlas_data_dir):
    p = pdf_cache.cache_path("2404.12345")
    assert p == atlas_data_dir / "pdfs" / "2404.12345.pdf"


@pytest.mark.asyncio
async def test_ensure_cached_downloads_when_missing(atlas_data_dir, fixtures_dir):
    db.init()
    papers.upsert([SAMPLE])
    pdf_bytes = (fixtures_dir / "tiny.pdf").read_bytes()

    fake_resp = AsyncMock()
    fake_resp.content = pdf_bytes
    fake_resp.raise_for_status = lambda: None

    with patch("app.pdf_cache.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.get = AsyncMock(return_value=fake_resp)

        path = await pdf_cache.ensure_cached("2404.12345")

    assert path.exists()
    assert path.read_bytes() == pdf_bytes
    assert papers.get("2404.12345")["pdf_path"] == str(path)


@pytest.mark.asyncio
async def test_ensure_cached_skips_download_when_present(atlas_data_dir):
    db.init()
    papers.upsert([SAMPLE])
    target = pdf_cache.cache_path("2404.12345")
    target.write_bytes(b"%PDF-1.4 already-here")

    with patch("app.pdf_cache.httpx.AsyncClient") as MockClient:
        path = await pdf_cache.ensure_cached("2404.12345")
        MockClient.assert_not_called()

    assert path.read_bytes() == b"%PDF-1.4 already-here"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest backend/tests/test_pdf_cache.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.pdf_cache'`.

- [ ] **Step 4: Implement `backend/app/pdf_cache.py`**

```python
"""On-disk PDF cache: fetch from arXiv once, serve from disk forever."""

from __future__ import annotations

from pathlib import Path

import httpx

from app import db, papers


PDF_URL_TEMPLATE = "https://arxiv.org/pdf/{arxiv_id}"


def cache_path(arxiv_id: str) -> Path:
    return db.data_dir() / "pdfs" / f"{arxiv_id}.pdf"


async def ensure_cached(arxiv_id: str, timeout: float = 60.0) -> Path:
    """Return path to the cached PDF, downloading first if needed."""
    target = cache_path(arxiv_id)
    if not target.exists():
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(PDF_URL_TEMPLATE.format(arxiv_id=arxiv_id))
            resp.raise_for_status()
            target.write_bytes(resp.content)
    if papers.get(arxiv_id) is not None:
        papers.set_pdf_path(arxiv_id, str(target))
    return target
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest backend/tests/test_pdf_cache.py -v`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/app/pdf_cache.py backend/tests/test_pdf_cache.py backend/tests/fixtures/tiny.pdf
git commit -m "feat(pdf-cache): on-disk PDF cache with arXiv download fallback"
```

---

## Task 7: AI availability detection

**Files:**
- Create: `backend/app/health.py`
- Create: `backend/tests/test_health.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_health.py`:

```python
from unittest.mock import patch, MagicMock

from app import health


def test_claude_available_returns_true_when_version_succeeds():
    fake = MagicMock(returncode=0, stdout="claude-code 1.2.3\n")
    with patch("app.health.subprocess.run", return_value=fake):
        assert health.claude_available() is True


def test_claude_available_returns_false_when_command_missing():
    with patch("app.health.subprocess.run", side_effect=FileNotFoundError):
        assert health.claude_available() is False


def test_claude_available_returns_false_when_nonzero_exit():
    fake = MagicMock(returncode=1, stdout="", stderr="error")
    with patch("app.health.subprocess.run", return_value=fake):
        assert health.claude_available() is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_health.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.health'`.

- [ ] **Step 3: Implement `backend/app/health.py`**

```python
"""Detect whether the local `claude` CLI is available for AI calls."""

from __future__ import annotations

import subprocess


def claude_available() -> bool:
    """Return True if `claude --version` exits 0 within a few seconds."""
    try:
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_health.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/health.py backend/tests/test_health.py
git commit -m "feat(health): detect claude CLI availability via subprocess"
```

---

## Task 8: Digest builder (no AI yet)

**Files:**
- Create: `backend/app/digest.py`
- Create: `backend/tests/test_digest.py`

The digest builder fetches recent papers from two arXiv queries (cs.PL all + cs.AR/cs.DC keyword-filtered, matching the existing `~/.claude/compiler-papers.sh` queries), persists them, and returns the assembled list. AI tiering is added in Plan 3.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_digest.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch

from app import db, digest, papers
from app.arxiv import Paper


@pytest.mark.asyncio
async def test_build_today_fetches_two_queries_and_persists(atlas_data_dir):
    db.init()
    pl = [Paper("1", "t", "a", "x", "cs.PL", "2026-04-19T08:00:00Z")]
    other = [Paper("2", "t", "a", "x", "cs.AR", "2026-04-19T09:00:00Z")]

    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[pl, other])):
        result = await digest.build_today()

    assert {r["arxiv_id"] for r in result} == {"1", "2"}
    assert papers.get("1") is not None
    assert papers.get("2") is not None


@pytest.mark.asyncio
async def test_build_today_dedupes_overlapping_results(atlas_data_dir):
    db.init()
    same = Paper("dup", "t", "a", "x", "cs.PL", "2026-04-19T08:00:00Z")
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[[same], [same]])):
        result = await digest.build_today()

    assert len(result) == 1
    assert result[0]["arxiv_id"] == "dup"


@pytest.mark.asyncio
async def test_build_today_writes_build_status_row(atlas_data_dir):
    db.init()
    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[[], []])):
        await digest.build_today()

    with db.connect() as conn:
        rows = list(conn.execute("SELECT date, status FROM builds"))
    assert len(rows) == 1
    assert rows[0]["status"] == "done"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_digest.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.digest'`.

- [ ] **Step 3: Implement `backend/app/digest.py`**

```python
"""Build today's digest: fetch arXiv, dedupe, persist. AI ranking added in Plan 3."""

from __future__ import annotations

import sqlite3
from datetime import date, datetime
from typing import List

from app import arxiv, db, papers


# Mirrors ~/.claude/compiler-papers.sh
PL_QUERY = "cat:cs.PL"
KEYWORD_QUERY = (
    '(cat:cs.AR OR cat:cs.DC) AND '
    '(all:compiler OR all:MLIR OR all:LLVM OR all:"code generation" '
    'OR all:DSL OR all:"intermediate representation" '
    'OR all:"tensor compiler" OR all:"kernel optimization" '
    'OR all:autotuning OR all:polyhedral OR all:vectorization '
    'OR all:"loop optimization" OR all:tiling OR all:scheduling '
    'OR all:dataflow OR all:HLS OR all:"hardware synthesis" '
    'OR all:"instruction selection")'
)


def _today_iso() -> str:
    return date.today().isoformat()


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _record_build(status: str, paper_count: int = 0, log: str = "") -> None:
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO builds (date, status, started_at, finished_at, paper_count, log)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(date) DO UPDATE SET
                 status=excluded.status,
                 finished_at=excluded.finished_at,
                 paper_count=excluded.paper_count,
                 log=excluded.log""",
            (_today_iso(), status, _now_iso(), _now_iso(), paper_count, log),
        )


async def build_today() -> List[sqlite3.Row]:
    """Fetch both arXiv queries, dedupe, persist, and return the row set."""
    pl = await arxiv.fetch_recent(PL_QUERY, max_results=100)
    other = await arxiv.fetch_recent(KEYWORD_QUERY, max_results=30)

    seen: dict[str, arxiv.Paper] = {}
    for p in (*pl, *other):
        seen.setdefault(p.arxiv_id, p)

    papers.upsert(list(seen.values()))
    rows = papers.list_recent(days=3)
    _record_build(status="done", paper_count=len(seen))
    return rows
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_digest.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/digest.py backend/tests/test_digest.py
git commit -m "feat(digest): assemble today's papers from arXiv (no AI yet)"
```

---

## Task 9: FastAPI app skeleton + /api/health

**Files:**
- Create: `backend/app/main.py`
- Create: `backend/tests/test_main.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_main.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import patch

from app import db
from app.main import app


@pytest.mark.asyncio
async def test_health_endpoint_returns_ai_status(atlas_data_dir):
    db.init()
    with patch("app.main.health.claude_available", return_value=True):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ai"] is True
    assert "papers_today" in body


@pytest.mark.asyncio
async def test_health_endpoint_when_claude_missing(atlas_data_dir):
    db.init()
    with patch("app.main.health.claude_available", return_value=False):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/health")
    assert r.json()["ai"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_main.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 3: Implement `backend/app/main.py`**

```python
"""Atlas FastAPI app — wires HTTP routes to the modules in this package."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import db, health, papers


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    yield


app = FastAPI(title="Atlas", lifespan=lifespan)


@app.get("/api/health")
async def get_health() -> dict:
    return {
        "ai": health.claude_available(),
        "papers_today": len(papers.list_recent(days=1)),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_main.py -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_main.py
git commit -m "feat(main): FastAPI app with /api/health endpoint"
```

---

## Task 10: /api/digest endpoint

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_main.py`

- [ ] **Step 1: Add the failing test**

Append to `backend/tests/test_main.py`:

```python
from unittest.mock import AsyncMock
from app.arxiv import Paper


@pytest.mark.asyncio
async def test_digest_endpoint_triggers_build_and_returns_papers(atlas_data_dir):
    db.init()
    sample = [Paper("1", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")]
    with patch("app.main.digest.build_today", new=AsyncMock(return_value=[])):
        with patch("app.main.papers.list_recent", return_value=sample):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                r = await c.get("/api/digest?build=true")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["papers"][0]["arxiv_id"] == "1"


@pytest.mark.asyncio
async def test_digest_without_build_does_not_call_builder(atlas_data_dir):
    db.init()
    fake_build = AsyncMock()
    with patch("app.main.digest.build_today", fake_build):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/digest")
    fake_build.assert_not_called()
    assert r.status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_main.py::test_digest_endpoint_triggers_build_and_returns_papers -v`
Expected: FAIL with 404 or AttributeError.

- [ ] **Step 3: Add the digest route to `backend/app/main.py`**

Add to imports:
```python
from app import digest
```

Append to file:

```python
def _row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()}


@app.get("/api/digest")
async def get_digest(build: bool = False) -> dict:
    if build:
        await digest.build_today()
    rows = papers.list_recent(days=3)
    return {"count": len(rows), "papers": [_row_to_dict(r) for r in rows]}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_main.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_main.py
git commit -m "feat(main): /api/digest endpoint with optional build trigger"
```

---

## Task 11: /api/papers/{id} endpoint

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_main.py`

- [ ] **Step 1: Add the failing test**

Append to `backend/tests/test_main.py`:

```python
@pytest.mark.asyncio
async def test_get_paper_returns_row_when_found(atlas_data_dir):
    db.init()
    papers.upsert([Paper("99", "Hello", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/papers/99")
    assert r.status_code == 200
    assert r.json()["title"] == "Hello"


@pytest.mark.asyncio
async def test_get_paper_returns_404_when_missing(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/papers/missing")
    assert r.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_main.py::test_get_paper_returns_row_when_found -v`
Expected: FAIL with 404 (route not yet defined) or AttributeError.

- [ ] **Step 3: Add the route to `backend/app/main.py`**

Add to imports:
```python
from fastapi import HTTPException
```

Append to file:

```python
@app.get("/api/papers/{arxiv_id}")
async def get_paper(arxiv_id: str) -> dict:
    row = papers.get(arxiv_id)
    if row is None:
        raise HTTPException(status_code=404, detail="paper not found")
    return _row_to_dict(row)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_main.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_main.py
git commit -m "feat(main): /api/papers/{id} endpoint with 404 handling"
```

---

## Task 12: /api/pdf/{id} endpoint

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_main.py`

- [ ] **Step 1: Add the failing test**

Append to `backend/tests/test_main.py`:

```python
@pytest.mark.asyncio
async def test_get_pdf_returns_cached_bytes(atlas_data_dir, fixtures_dir):
    db.init()
    papers.upsert([Paper("44", "T", "A", "x", "cs.PL", "2026-04-19T08:00:00Z")])
    pdf_bytes = (fixtures_dir / "tiny.pdf").read_bytes()
    target = atlas_data_dir / "pdfs" / "44.pdf"
    target.write_bytes(pdf_bytes)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/pdf/44")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content == pdf_bytes


@pytest.mark.asyncio
async def test_get_pdf_returns_404_when_paper_missing(atlas_data_dir):
    db.init()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/pdf/nope")
    assert r.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_main.py::test_get_pdf_returns_cached_bytes -v`
Expected: FAIL with 404.

- [ ] **Step 3: Add the route to `backend/app/main.py`**

Add to imports:
```python
from fastapi.responses import FileResponse
from app import pdf_cache
```

Append to file:

```python
@app.get("/api/pdf/{arxiv_id}")
async def get_pdf(arxiv_id: str):
    if papers.get(arxiv_id) is None:
        raise HTTPException(status_code=404, detail="paper not found")
    path = await pdf_cache.ensure_cached(arxiv_id)
    return FileResponse(path, media_type="application/pdf", filename=f"{arxiv_id}.pdf")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_main.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_main.py
git commit -m "feat(main): /api/pdf/{id} endpoint serving cached PDFs"
```

---

## Task 13: `atlas` CLI

**Files:**
- Create: `backend/app/cli.py`
- Create: `backend/tests/test_cli.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_cli.py`:

```python
from unittest.mock import patch

from app import cli


def test_status_command_when_running(capsys, atlas_data_dir):
    pid_file = atlas_data_dir / "atlas.pid"
    pid_file.write_text("12345")
    with patch("app.cli._is_alive", return_value=True):
        cli.main(["status"])
    captured = capsys.readouterr()
    assert "running" in captured.out
    assert "12345" in captured.out


def test_status_command_when_not_running(capsys, atlas_data_dir):
    cli.main(["status"])
    captured = capsys.readouterr()
    assert "not running" in captured.out


def test_start_writes_pid_file(atlas_data_dir):
    with patch("app.cli.subprocess.Popen") as MockPopen:
        MockPopen.return_value.pid = 99999
        cli.main(["start"])
    pid_file = atlas_data_dir / "atlas.pid"
    assert pid_file.exists()
    assert pid_file.read_text().strip() == "99999"


def test_stop_removes_pid_file(atlas_data_dir):
    pid_file = atlas_data_dir / "atlas.pid"
    pid_file.write_text("12345")
    with patch("app.cli.os.kill") as MockKill:
        cli.main(["stop"])
    assert not pid_file.exists()
    MockKill.assert_called_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_cli.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.cli'`.

- [ ] **Step 3: Implement `backend/app/cli.py`**

```python
"""`atlas` CLI: start, stop, status, logs, open."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Optional, Sequence

from app import db


PORT = 8765


def _pid_file() -> Path:
    return db.data_dir() / "atlas.pid"


def _log_file() -> Path:
    return db.data_dir() / "atlas.log"


def _read_pid() -> Optional[int]:
    p = _pid_file()
    if not p.exists():
        return None
    try:
        return int(p.read_text().strip())
    except ValueError:
        return None


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def cmd_start() -> int:
    if (pid := _read_pid()) and _is_alive(pid):
        print(f"already running (pid {pid})")
        return 0
    log = _log_file().open("ab")
    proc = subprocess.Popen(
        ["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        stdout=log, stderr=log,
        start_new_session=True,
    )
    _pid_file().write_text(str(proc.pid))
    print(f"started (pid {proc.pid}) on http://localhost:{PORT}")
    return 0


def cmd_stop() -> int:
    pid = _read_pid()
    if pid is None:
        print("not running")
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    _pid_file().unlink(missing_ok=True)
    print(f"stopped (pid {pid})")
    return 0


def cmd_status() -> int:
    pid = _read_pid()
    if pid and _is_alive(pid):
        print(f"running (pid {pid}) on http://localhost:{PORT}")
    else:
        print("not running")
    return 0


def cmd_logs() -> int:
    log = _log_file()
    if not log.exists():
        print("no log file yet")
        return 0
    sys.stdout.write(log.read_text())
    return 0


def cmd_open() -> int:
    webbrowser.open(f"http://localhost:{PORT}")
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="atlas")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("start", "stop", "status", "logs", "open"):
        sub.add_parser(name)
    args = parser.parse_args(argv)
    return {
        "start":  cmd_start,
        "stop":   cmd_stop,
        "status": cmd_status,
        "logs":   cmd_logs,
        "open":   cmd_open,
    }[args.cmd]()


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_cli.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/cli.py backend/tests/test_cli.py
git commit -m "feat(cli): atlas start/stop/status/logs/open commands"
```

---

## Task 14: End-to-end smoke test

**Files:**
- Create: `backend/tests/test_e2e.py`

- [ ] **Step 1: Write the smoke test**

Create `backend/tests/test_e2e.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app import db
from app.arxiv import Paper
from app.main import app


@pytest.mark.asyncio
async def test_full_round_trip_health_digest_paper_pdf(atlas_data_dir, fixtures_dir):
    """Build today's digest, fetch the digest, fetch one paper, fetch its PDF."""
    pl = [Paper("99", "Title", "A", "An abstract", "cs.PL", "2026-04-19T08:00:00Z")]
    other: list[Paper] = []
    pdf_bytes = (fixtures_dir / "tiny.pdf").read_bytes()

    fake_pdf_resp = AsyncMock()
    fake_pdf_resp.content = pdf_bytes
    fake_pdf_resp.raise_for_status = lambda: None

    with patch("app.digest.arxiv.fetch_recent", new=AsyncMock(side_effect=[pl, other])):
        with patch("app.pdf_cache.httpx.AsyncClient") as MockClient:
            instance = MockClient.return_value.__aenter__.return_value
            instance.get = AsyncMock(return_value=fake_pdf_resp)
            with patch("app.main.health.claude_available", return_value=False):
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                    h = await c.get("/api/health")
                    assert h.json()["ai"] is False

                    d = await c.get("/api/digest?build=true")
                    assert d.json()["count"] == 1
                    assert d.json()["papers"][0]["arxiv_id"] == "99"

                    p = await c.get("/api/papers/99")
                    assert p.json()["title"] == "Title"

                    f = await c.get("/api/pdf/99")
                    assert f.headers["content-type"] == "application/pdf"
                    assert f.content == pdf_bytes
```

- [ ] **Step 2: Run the test**

Run: `pytest backend/tests/test_e2e.py -v`
Expected: 1 passed.

- [ ] **Step 3: Run the full test suite**

Run: `pytest -v`
Expected: all tests pass (~24 tests across all files).

- [ ] **Step 4: Manually verify the dev server boots**

```bash
atlas start
sleep 2
curl -s http://localhost:8765/api/health
```

Expected JSON output: `{"ai": <true_or_false>, "papers_today": 0}`.

```bash
atlas stop
```

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_e2e.py
git commit -m "test: end-to-end smoke covering health, digest, paper, and pdf endpoints"
```

---

## Task 15: Update README with run instructions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md` with the realized backend**

Replace the contents of `README.md` with:

```markdown
# Atlas

Local-first paper reviewer. Browses arXiv papers, summarizes on-demand using your Claude subscription. Runs entirely on your Mac.

## Status

**Plan 1 — Backend foundation: complete.** No frontend yet; interact via curl. AI features land in Plan 3.

## Setup

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Running the dev server

```bash
atlas start          # http://localhost:8765
atlas status
atlas logs
atlas stop
```

## Endpoints (Plan 1)

- `GET /api/health` — `{ai, papers_today}`
- `GET /api/digest?build=true` — fetch today's arXiv papers and persist
- `GET /api/digest` — return persisted papers (no fetch)
- `GET /api/papers/{arxiv_id}` — single paper metadata
- `GET /api/pdf/{arxiv_id}` — cached PDF (downloads from arXiv on first request)

## Tests

```bash
pytest -v
```

## Data location

`~/.atlas/atlas.db` and `~/.atlas/pdfs/`. Override with `ATLAS_DATA_DIR=/some/path`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README for Plan 1 backend foundation"
```

---

## Done — Plan 1 deliverables

- A FastAPI server with 4 endpoints (`/api/health`, `/api/digest`, `/api/papers/{id}`, `/api/pdf/{id}`)
- SQLite-backed paper persistence
- Async arXiv fetcher with two queries (cs.PL all + cs.AR/cs.DC keyword filter)
- Local PDF cache that downloads on demand
- AI-availability detection via `claude --version`
- `atlas` CLI (start/stop/status/logs/open)
- ~24 passing tests with isolated temp dirs

**No AI calls happen yet** — that's Plan 3. **No frontend yet** — that's Plan 2.

After this lands, the next plan (`2026-XX-XX-atlas-plan-2-frontend-shell.md`) builds the React + Vite + Tailwind + shadcn/ui frontend with the PDF reader.
