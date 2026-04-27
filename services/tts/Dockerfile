FROM python:3.12-slim

# espeak-ng is the phonemizer backend Kokoro uses for English fallback.
# ffmpeg is included so debugging audio inside the container is easy.
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pre-install CPU-only torch from the PyTorch index BEFORE kokoro pulls
# it in transitively. The default PyPI torch wheel declares NVIDIA CUDA
# libs as runtime deps (cusolver, cusparse, cudnn — ~2 GB total) that
# can't run on Apple Silicon and would bloat the image / fill the build
# disk. The CPU-only index is much smaller and sufficient for our use.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-warm: instantiate the pipeline at build time so the first request
# isn't slow. This downloads the Kokoro model into the image layer.
RUN python -c "from kokoro import KPipeline; KPipeline(lang_code='a')"

COPY server.py ./

EXPOSE 8767
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
    CMD python -c "import httpx,sys; sys.exit(0 if httpx.get('http://127.0.0.1:8767/health', timeout=3).status_code==200 else 1)"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8767"]
