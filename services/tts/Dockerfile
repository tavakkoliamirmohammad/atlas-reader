FROM python:3.12-slim

# espeak-ng is the phonemizer backend Kokoro uses for English fallback.
# ffmpeg is included so debugging audio inside the container is easy.
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-warm: instantiate the pipeline at build time so the first request
# isn't slow. This downloads the Kokoro model into the image layer.
RUN python -c "from kokoro import KPipeline; KPipeline(lang_code='a')"

COPY server.py test_server.py ./

ENV TTS_PORT=8767
EXPOSE 8767
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
    CMD python -c "import httpx,sys; sys.exit(0 if httpx.get('http://127.0.0.1:8767/health').status_code==200 else 1)"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8767"]
