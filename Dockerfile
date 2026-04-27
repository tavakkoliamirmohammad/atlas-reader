# syntax=docker/dockerfile:1.7

# -------- Stage 1: build frontend --------
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
RUN corepack enable

COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm build

# -------- Stage 2: python runtime --------
FROM python:3.12-slim AS runtime
WORKDIR /app

# ffmpeg is used by the podcast orchestrator to concat per-sentence WAVs
# into a single MP3 deliverable.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ATLAS_DATA_DIR=/data

COPY pyproject.toml ./
COPY backend/ ./backend/
RUN pip install --no-cache-dir -e .

# Static frontend bundle from stage 1.
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /data

EXPOSE 8765
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765", "--app-dir", "backend"]
