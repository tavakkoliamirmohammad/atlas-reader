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
