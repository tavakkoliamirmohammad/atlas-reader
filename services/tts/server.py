from __future__ import annotations
import io
from typing import Final

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from kokoro import KPipeline

DEFAULT_VOICE: Final = "af_bella"
SAMPLE_RATE: Final = 24_000
MAX_CHARS: Final = 5_000

app = FastAPI()
_pipeline = KPipeline(lang_code="a")  # 'a' = American English


class SynthRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    voice: str = DEFAULT_VOICE


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "voice": DEFAULT_VOICE, "sample_rate": str(SAMPLE_RATE)}


@app.post("/synthesize")
def synthesize(req: SynthRequest) -> Response:
    try:
        # KPipeline yields (graphemes, phonemes, audio_ndarray) per chunk.
        # audio is already a numpy float32 array at 24 kHz — no .numpy() needed.
        chunks = [audio for _, _, audio in _pipeline(req.text, voice=req.voice)]
    except Exception as e:  # noqa: BLE001 — surface upstream error to caller
        raise HTTPException(500, f"synthesis failed: {e!s}") from e
    if not chunks:
        raise HTTPException(500, "synthesis returned no audio")
    audio = np.concatenate(chunks).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    duration_ms = int(len(audio) / SAMPLE_RATE * 1000)
    return Response(
        buf.getvalue(),
        media_type="audio/wav",
        headers={"X-Audio-Duration-Ms": str(duration_ms)},
    )
