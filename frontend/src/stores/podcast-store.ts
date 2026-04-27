import { create } from "zustand";
import {
  type GenerateRequest,
  type Length,
  type Manifest,
  type PodcastEvent,
  type Segment,
  deletePodcast,
  fetchManifest,
  podcastAudioUrl,
  streamGenerate,
} from "@/lib/podcastApi";

export type GenerationState =
  | "idle"
  | "scripting"
  | "synthesizing"
  | "ready"
  | "error";

export type CurrentPodcast = {
  arxiv_id: string;
  length: Length;
  paperTitle: string;
  url: string;
  segments: Segment[];
  duration_s: number;
  voice: string;
  model: string;
  // Inputs to the original generate() call, kept so regenerate() can re-run
  // with the same backend/model the user originally chose.
  origBackend: string | undefined;
  origModel: string | undefined;
};

type PodcastState = {
  current: CurrentPodcast | null;
  generationState: GenerationState;
  scriptDraft: string;
  progress: { synthesized_s: number; total_s_estimate: number };
  error: { phase: string; message: string } | null;
  position: number;
  isPlaying: boolean;

  generate: (args: {
    arxiv_id: string;
    length: Length;
    paperTitle: string;
    backend?: string;
    model?: string;
  }) => Promise<void>;
  regenerate: () => Promise<void>;
  setPosition: (s: number) => void;
  setPlaying: (b: boolean) => void;
  close: () => void;
  rehydrate: () => Promise<void>;
};

const STORAGE_KEY = "atlas.podcast.session.v1";
const POSITION_PERSIST_INTERVAL_MS = 1000;

// Monotonic counter incremented at the top of every generate(); late async
// callbacks (notably the manifest fetch after a `ready` event) compare against
// the token value they captured to detect closed/superseded sessions.
let _currentGenerationToken = 0;

let _positionFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingPosition: number | null = null;

function schedulePersistPosition(s: number) {
  _pendingPosition = s;
  if (_positionFlushTimer !== null) return;
  _positionFlushTimer = setTimeout(() => {
    _positionFlushTimer = null;
    if (_pendingPosition === null) return;
    const cur = usePodcastStore.getState().current;
    if (!cur) return;
    savePersisted({
      arxiv_id: cur.arxiv_id,
      length: cur.length,
      paperTitle: cur.paperTitle,
      position: _pendingPosition,
    });
    _pendingPosition = null;
  }, POSITION_PERSIST_INTERVAL_MS);
}

type Persisted = {
  arxiv_id: string;
  length: Length;
  paperTitle: string;
  position: number;
};

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

function savePersisted(p: Persisted | null) {
  try {
    if (p === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // localStorage may be disabled (e.g. private mode); tolerate silently.
  }
}

export const usePodcastStore = create<PodcastState>((set, get) => ({
  current: null,
  generationState: "idle",
  scriptDraft: "",
  progress: { synthesized_s: 0, total_s_estimate: 0 },
  error: null,
  position: 0,
  isPlaying: false,

  async generate({ arxiv_id, length, paperTitle, backend, model }) {
    // Track this generation's identity so late async callbacks (notably the
    // fire-and-forget fetchManifest after a `ready` event) can detect when
    // the user has closed the player or started a new generation, and skip
    // their state writes instead of resurrecting a closed session.
    const generationToken = ++_currentGenerationToken;

    set({
      generationState: "scripting",
      scriptDraft: "",
      progress: { synthesized_s: 0, total_s_estimate: 0 },
      error: null,
      current: null,
      position: 0,
      isPlaying: false,
    });

    const req: GenerateRequest = { arxiv_id, length, backend, model };

    await streamGenerate(req, {
      onEvent: (ev: PodcastEvent) => {
        if (ev.type === "script_chunk") {
          set((s) => {
            // Drop any chunks that arrive after we've left the scripting phase
            // (e.g. an error event flipped state to "error" before the next
            // chunk landed). Without this guard the partial transcript keeps
            // growing while the UI is in an error state — visually confusing.
            if (s.generationState !== "scripting") return s;
            return { scriptDraft: s.scriptDraft + ev.text };
          });
        } else if (ev.type === "tts_progress") {
          set({
            generationState: "synthesizing",
            progress: { synthesized_s: ev.synthesized_s, total_s_estimate: ev.total_s_estimate },
          });
        } else if (ev.type === "ready") {
          const url = ev.url;
          const readySegments = ev.segments;
          const readyDuration = ev.duration_s;
          // Manifest's voice/model live in the JSON sibling. Fire-and-forget
          // fetch — the guard below skips state writes if the user closed the
          // player while the request was in-flight.
          const finalize = (voice: string, modelLabel: string) => {
            if (generationToken !== _currentGenerationToken) return;
            set({
              current: {
                arxiv_id, length, paperTitle, url,
                segments: readySegments,
                duration_s: readyDuration,
                voice, model: modelLabel,
                origBackend: backend,
                origModel: model,
              },
              generationState: "ready",
            });
            savePersisted({ arxiv_id, length, paperTitle, position: 0 });
          };
          fetchManifest(arxiv_id, length)
            .then((m) => finalize(m?.voice ?? "", m?.model ?? ""))
            .catch(() => finalize("", ""));
        } else if (ev.type === "error") {
          set({
            generationState: "error",
            error: { phase: ev.phase, message: ev.message },
          });
        }
      },
      onError: (msg) => {
        set({
          generationState: "error",
          error: { phase: "transport", message: msg },
        });
      },
    });
  },

  async regenerate() {
    const cur = get().current;
    if (!cur) return;
    try {
      await deletePodcast(cur.arxiv_id, cur.length);
    } catch (err) {
      // If the cache delete fails, the next generate() call will see the
      // stale cached file and return the OLD podcast — silently. Surface
      // the error instead of pretending the regenerate succeeded.
      set({
        generationState: "error",
        error: { phase: "delete", message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    await get().generate({
      arxiv_id: cur.arxiv_id,
      length: cur.length,
      paperTitle: cur.paperTitle,
      backend: cur.origBackend,
      model: cur.origModel,
    });
  },

  setPosition(s) {
    set({ position: s });
    // Persist position at most once per second; <audio>'s timeupdate fires
    // ~4x/s during playback, which is more localStorage churn than the
    // session-recovery use case needs (precision required = seconds).
    schedulePersistPosition(s);
  },

  setPlaying(b) { set({ isPlaying: b }); },

  close() {
    set({
      current: null,
      generationState: "idle",
      scriptDraft: "",
      progress: { synthesized_s: 0, total_s_estimate: 0 },
      error: null,
      position: 0,
      isPlaying: false,
    });
    savePersisted(null);
  },

  async rehydrate() {
    const p = loadPersisted();
    if (!p) return;
    let manifest: Manifest | null;
    try {
      manifest = await fetchManifest(p.arxiv_id, p.length);
    } catch {
      // Network error: keep whatever was on disk; UI will recover on next call.
      return;
    }
    if (!manifest) {
      savePersisted(null);  // cache was invalidated; clear persistence
      return;
    }
    set({
      current: {
        arxiv_id: p.arxiv_id,
        length: p.length,
        paperTitle: p.paperTitle,
        url: podcastAudioUrl(p.arxiv_id, p.length),
        segments: manifest.segments,
        duration_s: manifest.duration_s,
        voice: manifest.voice,
        model: manifest.model,
        // Rehydrated sessions don't know the user's original backend/model
        // overrides; regenerate() will use the current defaults.
        origBackend: undefined,
        origModel: undefined,
      },
      generationState: "ready",
      position: p.position,
      isPlaying: false,
    });
  },
}));
