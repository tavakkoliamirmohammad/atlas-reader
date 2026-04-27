FROM python:3.12-slim

# espeak-ng is the phonemizer backend Kokoro uses for English fallback.
# ffmpeg is included so debugging audio inside the container is easy.
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# BUILD_VARIANT controls which PyTorch wheel index we use.
#   cpu  (default) — works everywhere, including Docker on macOS (Apple
#                    Silicon GPU is not reachable from the Linux VM).
#   cuda           — pulls CUDA 12.1 wheels; only useful on Linux hosts
#                    with an NVIDIA GPU + nvidia-container-toolkit, run
#                    with `docker run --gpus all`.
# Build CPU image:  docker build services/tts
# Build CUDA image: docker build --build-arg BUILD_VARIANT=cuda services/tts
ARG BUILD_VARIANT=cpu
RUN if [ "$BUILD_VARIANT" = "cuda" ]; then \
        pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu121; \
    else \
        pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu; \
    fi

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-warm: instantiate the pipeline at build time so the first request
# isn't slow. This downloads the Kokoro model into the image layer.
RUN python -c "from kokoro import KPipeline; KPipeline(lang_code='a')"

COPY server.py ./

EXPOSE 8767
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
    CMD python -c "import httpx,sys; sys.exit(0 if httpx.get('http://127.0.0.1:8767/health').status_code==200 else 1)"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8767"]
