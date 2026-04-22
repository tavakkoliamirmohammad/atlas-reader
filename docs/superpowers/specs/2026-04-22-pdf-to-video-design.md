# PDF → Introductory Video

**Date:** 2026-04-22
**Status:** Approved
**Scope:** One plan. Covers the new "Generate video" feature: a 3–5 minute narrated explainer of a selected paper, rendered fully locally with no API keys and no recurring cost.

## Goal

From the reader page, the user picks a persona (`general | researcher | practitioner`), clicks **Generate video**, and — after a few minutes — watches an in-line video player show a 3–5 min narrated tour of the paper. The tour mixes real paper content (figures, code, IR blocks) with animated concept scenes, all driven by a locally-rendered audio track.

The output is a single MP4 at `~/.atlas/videos/<paper_id>-<persona>.mp4`, playable inline in the reader and downloadable.

## Non-goals

- Shared/hosted video rendering. All rendering stays on the user's machine. Matches Atlas's local-first hosting model.
- Live/streamed video (no WebRTC, no progressive playback during render). The user sees SSE progress, then the finished MP4.
- Voice cloning, multi-speaker dialogue, or custom voices. One English Piper voice, pinned in the design doc.
- Non-English narration. Piper's English voices are the best; multilingual is out of scope for v1.
- Manual editing of the storyboard or scene TSX. The flow is one-click generation; re-generation is the only way to change output.
- Re-using old renders when the underlying summary changes. A new render is always a fresh run.
- Running the video engine inside the existing Atlas Docker container. Video-engine stays host-side; the host-mode runner spawns Node/Piper/ffmpeg the same way it spawns `codex`/`claude`.

## Architecture

### Two-process model (unchanged)

Video generation lives entirely in the AI-runner/host-mode path. The backend orchestrates; the runner (or host-mode `ai_local`) spawns subprocesses. Security posture is preserved:

- The backend never invokes Node / Piper / ffmpeg directly when `ATLAS_AI_PROXY` is set.
- The runner gains typed job kinds `scene_render`, `tts_piper`, `ffmpeg_mux` alongside the existing AI jobs. Pydantic validates every field; no shell strings, no user-supplied argv.
- `ai_argv.py` gains argv builders for each new job kind, with the same "constants only, allowlist models, reject leading-dash strings" guardrails.

### New backend module: `backend/app/video.py`

Single orchestrator. Its public surface:

```python
async def generate(
    arxiv_id: str,
    persona: Literal["general", "researcher", "practitioner"],
    backend: Backend,
    model: str | None = None,
) -> AsyncIterator[VideoEvent]:
    ...
```

Emits `VideoEvent` objects that the route layer formats as SSE. Consumes `ai_backend.run_ai` for LLM stages; calls into `ai_backend.run_job` (new) for the new non-LLM runner jobs.

### New AI task kinds

Added to `ai_backend.py` + `ai_argv.py`:

- **`storyboard`** — input: paper summary + extracted figure manifest + persona. Output: JSON scene array (strict schema, see "Scene vocabulary"). One call per video.
- **`scene_tsx`** — input: one scene's storyboard entry + paper snippet (only for `concept` kind; all other kinds render via fixed templates). Output: a single Motion Canvas `.tsx` file. One call per concept scene.

Both reuse the existing `run_ai` plumbing. Directive is a constant string loaded from `backend/app/prompts/{storyboard,scene_tsx}.md` (first-class file so it's reviewable in PRs).

Default model table (`_DEFAULT_MODELS`) gains entries:

```python
("claude", "storyboard"): "opus",     # complex reasoning over paper structure
("codex",  "storyboard"): "gpt-5.4",  # flagship tier
("claude", "scene_tsx"):  "opus",     # code-gen; opus is strongest
("codex",  "scene_tsx"):  "gpt-5.4",  # flagship tier
```

Codex model strings must exist in `ai_argv.CODEX_MODELS`; if the allowlist moves, defaults move with it. Claude models remain the three-tier alias.

### New runner job kinds (non-LLM subprocesses)

The runner currently only runs AI CLIs. We extend it with three typed jobs, still gated by bearer token, host-header allowlist, concurrency semaphore, rate limit, and per-job timeout.

- **`scene_render`** — argv: `node <video-engine>/render-scene.js <tsx_path> <out_mp4>`. Timeout 120s.
- **`tts_piper`** — argv: `<video-engine>/piper --model <voice> --output_file <wav>`. stdin: narration text. Timeout 60s.
- **`ffmpeg_mux`** — argv: `ffmpeg -y -i <video> -i <audio> -c:v copy -c:a aac <out>` and a separate concat form. Timeout 60s.

All three argvs are built by `ai_argv.py`'s new `build_video_argv(kind, payload)` — the same single-source-of-truth discipline the AI argvs already have. No shell, no interpolation into strings.

### Figure extraction (deterministic, cached)

Runs once per paper, lazily on first video generation. Implemented in `backend/app/figures.py`:

- Uses `PyMuPDF` (`pymupdf` / `fitz`) already indirectly available through `pdfplumber`-class libraries — confirm on `pyproject.toml`. If not present, add it as a runtime dep.
- For each page, walk `page.get_images()` to pull embedded raster figures. For pages where figures are drawn via vector primitives (common in compiler/MLIR papers), render the full page at 2× and crop by heuristic bounding box.
- Captures caption text by finding the text block directly below the figure bbox (max 3 lines, starts with `Fig`, `Figure`, `Table`).
- Writes each figure to `~/.atlas/figures/<paper_id>/fig-<n>.png` + a `manifest.json` with `[{n, page, bbox_pdf, caption, path}]`.

Subsequent runs re-use the cache unless the PDF hash changes.

### Scene vocabulary (6 kinds, frozen)

Locked schema — scene kinds do not auto-extend. If the LLM emits an unknown `kind`, orchestrator rejects the storyboard and retries the storyboard call once; second failure surfaces to the user.

```jsonc
{
  "version": 1,
  "total_duration_sec": 240,
  "scenes": [
    { "kind": "title",       "duration": 5,  "narration": "...", "title": "...", "authors": ["...", "..."] },
    { "kind": "text",        "duration": 12, "narration": "...", "heading": "...", "bullets": ["..."] },
    { "kind": "figure-walk", "duration": 18, "narration": "...", "figure_n": 3, "annotations": [{"bbox_norm": [.1,.2,.5,.6], "label": "loop nest"}] },
    { "kind": "code",        "duration": 15, "narration": "...", "language": "mlir", "source": "...", "highlights": [[3,7]] },
    { "kind": "concept",     "duration": 22, "narration": "...", "brief": "show how tiling reorders loops" },
    { "kind": "chart",       "duration": 12, "narration": "...", "chart_type": "bar", "title": "Speedup", "series": [{"name": "baseline", "value": 1.0}, {"name": "ours", "value": 1.32}] }
  ]
}
```

Total duration must be in `[180, 300]` seconds. Orchestrator rejects and retries on violation.

`title`, `text`, `figure-walk`, `code`, `chart` → rendered by a fixed TSX template that takes the scene JSON as props. No LLM code-gen.

`concept` → LLM writes the TSX (one file per scene). This is the only brittleness surface.

### Motion Canvas project layout

Lives under `~/.atlas/video-engine/motion-canvas/` after `atlas install-video`. Structure:

```
motion-canvas/
├── package.json              (pinned deps: @motion-canvas/core, @motion-canvas/2d, @motion-canvas/ffmpeg)
├── node_modules/
├── templates/
│   ├── Title.tsx
│   ├── Text.tsx
│   ├── FigureWalk.tsx
│   ├── Code.tsx
│   └── Chart.tsx
├── render-scene.js           (CLI: reads scene JSON or TSX path, writes MP4)
└── theme.ts                  (colors, fonts — mirrors Atlas's theme palette)
```

Generated `concept` scenes are written to `~/.atlas/video-engine/work/<paper_id>/<persona>/scene-<n>.tsx`, then rendered in isolation so a failing scene doesn't poison the project.

### Pipeline (ordered)

1. **Summary preflight** — if the paper has no cached summary, block until summarization finishes (reuses existing `summarizer`).
2. **Figures** — ensure `~/.atlas/figures/<paper_id>/manifest.json` exists (deterministic extraction; skipped on cache hit).
3. **Storyboard** — one `ai_backend.run_ai(task="storyboard")` call. JSON-validated against the scene schema with tight zod-style checks in Pydantic. Total-duration + kind + required-fields checks; one retry on failure; surface error on second failure.
4. **Scene TSX generation** — for each `concept` scene only, fan out `ai_backend.run_ai(task="scene_tsx")` calls bounded by the existing concurrency semaphore. Each is an independent retry domain. On failure, substitute a fallback `Text` scene with the narration as a single bullet — the video never fails because of one scene. All other scene kinds skip this stage and render directly from their template.
5. **TTS** — one `tts_piper` runner job per scene, parallel. Output: `scene-<n>.wav`.
6. **Scene render** — one `scene_render` runner job per scene. Input: scene TSX path (template or generated). Output: silent `scene-<n>.mp4`.
7. **Mux** — per scene, `ffmpeg_mux` merges scene video + scene audio to `scene-<n>-muxed.mp4`.
8. **Concat** — one final ffmpeg concat into `~/.atlas/videos/<paper_id>-<persona>.mp4`.
9. **Record** — insert a row into the new `videos` table, drop a `video.ready` event in `events`.

Each stage emits an SSE event; the frontend turns them into a progress bar.

### Data model

New `videos` table, mirrors the shape of `conversations`:

```sql
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arxiv_id TEXT NOT NULL,
  persona TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'pending' | 'rendering' | 'done' | 'failed'
  storyboard_json TEXT,           -- full JSON for debugging/replay
  path TEXT,                       -- absolute path under ~/.atlas/videos/
  duration_sec INTEGER,
  error TEXT,                      -- populated on 'failed'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(arxiv_id, persona)
);
```

Schema lives in `db.py::SCHEMA` and is idempotent.

`UNIQUE(arxiv_id, persona)` is enforced; regeneration overwrites the existing row and replaces the MP4 on disk.

### Routes

- `POST /api/papers/{arxiv_id}/video/generate` — body `{persona, backend, model?}`. Returns SSE.
- `GET  /api/papers/{arxiv_id}/videos` — list all personas for this paper + status.
- `GET  /api/papers/{arxiv_id}/videos/{persona}/file` — streams the MP4 with `Content-Type: video/mp4` and `Accept-Ranges: bytes` so the `<video>` element can seek.
- `DELETE /api/papers/{arxiv_id}/videos/{persona}` — drops the row + deletes the file.

SSE event kinds (JSON-encoded payloads, matching `main.py::_sse_format`):

```
{"type":"storyboard","scenes":N}
{"type":"scene-progress","scene_idx":n,"phase":"tsx|tts|render|mux","status":"start|done|failed"}
{"type":"concat"}
{"type":"complete","path":"/Users/.../videos/...-general.mp4","duration_sec":235}
{"type":"error","where":"...","message":"..."}
```

### Frontend

- **New state in `ui-store.ts`** — ephemeral action counter `videoGenerateRequestId` + persistent `videoPersona: "general" | "researcher" | "practitioner"`.
- **`VideoPanel.tsx`** — opens as a tab alongside chat. Shows the latest video for the active persona, inline `<video controls>`. If none exists, shows the persona picker + "Generate" button.
- **`VideoProgress.tsx`** — per-scene progress list, each row lighting up as SSE events arrive. Overall bar = scenes-done / total-scenes.
- **`ReaderRoute`** — adds a new tab button between "Chat" and "Highlights". Pure UI, no new routing.
- **`frontend/src/lib/api.ts`** — typed `generateVideo`, `listVideos`, `deleteVideo` helpers; SSE consumed via the existing `lib/sse.ts`.

### CLI

Add two subcommands to the `atlas` CLI (`backend/app/cli.py`):

- **`atlas install-video`** — downloads/unpacks into `~/.atlas/video-engine/`:
  - Pinned Node distribution (the official tarball for the host arch, verified SHA-256 in a constant table).
  - `npm install --prefix motion-canvas` against a checked-in `package.json` + `package-lock.json` so the dep graph is reproducible.
  - Piper binary + `en_US-lessac-medium.onnx` voice, verified SHA-256.
  - Static FFmpeg build, verified SHA-256.
  - Writes `~/.atlas/video-engine/VERSION` with the shipped revision; on mismatch, `atlas doctor` recommends re-installing.
- **`atlas uninstall-video`** — rm -rf, with a confirmation prompt unless `-y`.

Total footprint target: **~400 MB**. If we exceed 600 MB at implementation time, revisit.

### `atlas doctor` updates

New section:

```
video-engine:
  path: /Users/.../.atlas/video-engine
  status: ready | missing | stale
  node: v20.x.x
  piper: vX.Y.Z (voice: en_US-lessac-medium)
  ffmpeg: 7.x
  motion-canvas: 3.x (locked)
```

## Testing

**Backend**

- `test_video_orchestrator.py` — happy-path generation with all subprocess calls mocked at the `run_ai` / `run_job` boundary. Assert SSE event sequence and final DB row.
- `test_video_storyboard_validation.py` — malformed storyboard JSON (bad `kind`, duration out of range, missing required field) triggers exactly one retry, then surfaces error.
- `test_video_scene_fallback.py` — a failing `scene_tsx` gen for a `concept` scene substitutes a `Text` fallback and the final video still produces.
- `test_video_argv.py` — argv builders for `scene_render` / `tts_piper` / `ffmpeg_mux` reject shell-metacharacter-laced inputs (extending the existing `test_ai_argv.py` invariants).
- `test_figures_extraction.py` — against 2–3 fixture PDFs (one MLIR paper with vector figures, one with raster figures), assert manifest shape and caption matching.
- `test_runner_security_video.py` — runner rejects video jobs without bearer, rejects host-header spoofing, enforces rate limit, per-job timeout kills subprocess.
- `test_main_video_routes.py` — generate → list → file (range request) → delete happy paths; 404 on missing persona.

**Frontend**

- `VideoPanel.test.tsx` — persona picker, Generate click fires `generateVideo`, SSE progress updates per-scene state.
- `VideoProgress.test.tsx` — renders each scene row, transitions on `scene-progress` events, finishes on `complete`.
- `api.test.ts` — typed client round-trips against mocked fetch; SSE events parse cleanly through `JSON.parse` (the newline trap).

**Manual smoke**

- `atlas install-video` on a clean machine; `atlas doctor` reports ready.
- Open a real MLIR paper; generate `general` persona; watch progress; play the resulting MP4 in the browser; download works; the file opens in QuickTime.
- Regenerate same persona → old file replaced, row overwritten, playback shows new content.
- Generate different persona → second MP4 appears; picker switches between them.
- Generate, then kill the backend mid-render → restart → DB row is `failed` (or `rendering` that the next scheduler tick marks `failed` after orphan detection); UI offers retry.

## Open risks

- **LLM-generated Motion Canvas TSX is brittle.** Mitigation: bounded per-scene domain + `Text` fallback means one bad scene doesn't kill a video. The orchestrator explicitly never invokes scene-TSX gen for `title/text/figure-walk/code/chart` — only `concept`, which is the scene kind the LLM is best at describing (and worst at rendering). We also test-run the generated TSX through `@motion-canvas/2d`'s type-check before rendering; syntax failures trigger a one-shot regenerate with the error attached.
- **Figure extraction misses vector figures.** Mitigation: the full-page-crop fallback. Long-term, consider `pdf-figures-2` (Java, heavier install) if the heuristic caption-match proves insufficient.
- **Render time.** 15–25 scenes × ~10–20 s of render each is 3–6 min on an M-series Mac. Acceptable for an opt-in "click and wait" flow. If scene render dominates, parallelize render jobs up to `os.cpu_count() - 1` and bound by the runner semaphore.
- **Disk usage.** A generated 3–5 min 1080p H.264 MP4 is ~30–60 MB. A user with 100 papers could hit ~6 GB across three personas. Mitigation: include video size in the existing `atlas doctor` output and document the `videos/` directory as safe to clear.
- **Piper voice quality degrades on technical jargon.** Known; acceptable v1. Future: normalize `LLVM`, `MLIR`, `SPMD`, `PHI` via a per-word pronunciation dictionary before TTS.
- **Node + Piper install size.** 400 MB is a lot. Mitigation: `install-video` is opt-in; `uninstall-video` is trivial. Clearly documented as optional.
- **macOS Gatekeeper / codesigning.** Piper + Node + ffmpeg binaries downloaded from upstream may be quarantined by macOS. Mitigation: `install-video` prints the exact `xattr -dr com.apple.quarantine` command if it detects quarantine after extraction; `atlas doctor` reports quarantined binaries.
- **Concurrent-video regression on the runner.** Current semaphore is 4. If the user generates multiple videos in parallel, scene renders from both fight for slots. Acceptable — the rate limiter protects the runner; videos take longer but don't break.
- **Container mode.** Video generation doesn't work when the backend runs in Docker because the video engine is host-side. Mitigation: same posture as Claude CLI today — `/api/papers/{id}/video/generate` returns 501 with a clear error if the runner doesn't advertise `video=true` in its `/health` response.

## Build order

1. **Scaffolding.** `videos` table + migration; new route stubs; `ai_backend` task-kind additions; `ai_argv` job-kind stubs; runner `/run` extended with the new job kinds (all returning "not implemented" at first).
2. **Figures.** `figures.py` + `test_figures_extraction.py` against fixture PDFs.
3. **Storyboard LLM task.** Prompt file, `ai_backend` entry, Pydantic schema, validation + retry loop. Test against a recorded storyboard fixture.
4. **Fixed scene templates.** `Title.tsx`, `Text.tsx`, `FigureWalk.tsx`, `Code.tsx`, `Chart.tsx` under `motion-canvas/templates/`. Locally runnable (`node render-scene.js templates/Title.tsx out.mp4`).
5. **`atlas install-video`.** Node + Piper + ffmpeg pinned, SHA-256 verified, mock-network-safe tests. `atlas doctor` section.
6. **Runner video jobs.** `scene_render`, `tts_piper`, `ffmpeg_mux` + argv builders + security tests.
7. **Scene TSX generation.** `scene_tsx` task + prompt + fallback-to-Text behaviour + tests.
8. **Orchestrator.** `video.py` wires stages 1–9 together. Happy-path + error-path tests with mocked runner jobs.
9. **SSE route.** `/api/papers/{id}/video/generate` streams events from `video.generate`.
10. **Video file + list + delete routes.** Range requests tested.
11. **Frontend: API client + ui-store slice.**
12. **Frontend: `VideoPanel` + `VideoProgress` + tab integration.**
13. **Manual smoke on a real paper.** Fix rough edges.
14. **README section** documenting `atlas install-video`, disk footprint, and the Docker-mode limitation.
