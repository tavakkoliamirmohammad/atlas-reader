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
          set((s) => ({
            scriptDraft: s.scriptDraft + ev.text,
            generationState:
              s.generationState === "scripting" ? "scripting" : s.generationState,
          }));
        } else if (ev.type === "tts_progress") {
          set({
            generationState: "synthesizing",
            progress: { synthesized_s: ev.synthesized_s, total_s_estimate: ev.total_s_estimate },
          });
        } else if (ev.type === "ready") {
          // We have the URL + segments but the manifest's voice/model live in
          // the JSON sibling. Fetch it for the player UI label.
          const url = ev.url;
          const readySegments = ev.segments;
          const readyDuration = ev.duration_s;
          fetchManifest(arxiv_id, length).then((m) => {
            set({
              current: {
                arxiv_id, length, paperTitle, url,
                segments: readySegments,
                duration_s: readyDuration,
                voice: m?.voice ?? "",
                model: m?.model ?? "",
              },
              generationState: "ready",
            });
            savePersisted({ arxiv_id, length, paperTitle, position: 0 });
          }).catch(() => {
            // Manifest fetch failed (rare race) — still set current with empty meta.
            set({
              current: {
                arxiv_id, length, paperTitle, url,
                segments: readySegments,
                duration_s: readyDuration,
                voice: "",
                model: "",
              },
              generationState: "ready",
            });
            savePersisted({ arxiv_id, length, paperTitle, position: 0 });
          });
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
    await deletePodcast(cur.arxiv_id, cur.length).catch(() => {});
    await get().generate({
      arxiv_id: cur.arxiv_id,
      length: cur.length,
      paperTitle: cur.paperTitle,
    });
  },

  setPosition(s) {
    set({ position: s });
    const cur = get().current;
    if (cur) {
      savePersisted({
        arxiv_id: cur.arxiv_id,
        length: cur.length,
        paperTitle: cur.paperTitle,
        position: s,
      });
    }
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
      },
      generationState: "ready",
      position: p.position,
      isPlaying: false,
    });
  },
}));
