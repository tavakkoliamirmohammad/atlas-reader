import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";

vi.mock("@/lib/podcastApi", () => ({
  streamGenerate: vi.fn(),
  fetchManifest: vi.fn(),
  deletePodcast: vi.fn(),
  podcastAudioUrl: (id: string, length: string) => `/api/podcast/${id}/${length}.mp3`,
}));

import * as api from "@/lib/podcastApi";
import { usePodcastStore } from "./podcast-store";

beforeEach(() => {
  localStorage.clear();
  // Reset store to initial state.
  usePodcastStore.getState().close();
  vi.clearAllMocks();
});

describe("podcast-store generate", () => {
  it("walks through scripting -> synthesizing -> ready", async () => {
    (api.streamGenerate as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: unknown, h: { onEvent: (ev: api.PodcastEvent) => void; onDone?: () => void }) => {
        h.onEvent({ type: "script_chunk", text: "hi " });
        h.onEvent({ type: "script_chunk", text: "there" });
        h.onEvent({ type: "tts_progress", synthesized_s: 1, total_s_estimate: 5 });
        h.onEvent({
          type: "ready",
          url: "/api/podcast/x/short.mp3",
          segments: [{ idx: 0, text: "hi", start_ms: 0, end_ms: 1000 }],
          duration_s: 1,
        });
        h.onDone?.();
      },
    );
    (api.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
      voice: "af_bella",
      model: "opus",
      segments: [],
      duration_s: 1,
      arxiv_id: "x",
      length: "short",
      backend: "claude",
      generated_at: 0,
      script: "",
    });

    await act(async () => {
      await usePodcastStore.getState().generate({
        arxiv_id: "x",
        length: "short",
        paperTitle: "T",
      });
      // Allow the fetchManifest .then() chain to flush.
      await new Promise((r) => setTimeout(r, 10));
    });

    const s = usePodcastStore.getState();
    expect(s.generationState).toBe("ready");
    expect(s.current?.arxiv_id).toBe("x");
    expect(s.current?.voice).toBe("af_bella");
    expect(s.current?.model).toBe("opus");
    expect(s.scriptDraft).toBe("hi there");
  });

  it("sets generationState=error when error event arrives mid-stream", async () => {
    (api.streamGenerate as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: unknown, h: { onEvent: (ev: api.PodcastEvent) => void; onDone?: () => void }) => {
        h.onEvent({ type: "script_chunk", text: "partial" });
        h.onEvent({ type: "error", phase: "tts", message: "TTS failed" });
        h.onDone?.();
      },
    );

    await act(async () => {
      await usePodcastStore.getState().generate({
        arxiv_id: "y",
        length: "medium",
        paperTitle: "Paper Y",
      });
    });

    const s = usePodcastStore.getState();
    expect(s.generationState).toBe("error");
    expect(s.error?.phase).toBe("tts");
    expect(s.error?.message).toBe("TTS failed");
    expect(s.scriptDraft).toBe("partial");
    expect(s.current).toBeNull();
  });

  it("sets generationState=error when onError is called", async () => {
    (api.streamGenerate as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: unknown, h: { onEvent: (ev: api.PodcastEvent) => void; onError?: (msg: string) => void }) => {
        h.onError?.("HTTP 500");
      },
    );

    await act(async () => {
      await usePodcastStore.getState().generate({
        arxiv_id: "z",
        length: "long",
        paperTitle: "Paper Z",
      });
    });

    const s = usePodcastStore.getState();
    expect(s.generationState).toBe("error");
    expect(s.error?.phase).toBe("transport");
    expect(s.error?.message).toBe("HTTP 500");
  });
});

describe("podcast-store regenerate", () => {
  it("calls deletePodcast then generate with same args", async () => {
    // First put something in current state.
    (api.streamGenerate as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: unknown, h: { onEvent: (ev: api.PodcastEvent) => void; onDone?: () => void }) => {
        h.onEvent({
          type: "ready",
          url: "/api/podcast/abc/short.mp3",
          segments: [],
          duration_s: 10,
        });
        h.onDone?.();
      },
    );
    (api.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
      voice: "v1",
      model: "haiku",
      segments: [],
      duration_s: 10,
      arxiv_id: "abc",
      length: "short",
      backend: "claude",
      generated_at: 0,
      script: "",
    });
    (api.deletePodcast as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await act(async () => {
      await usePodcastStore.getState().generate({
        arxiv_id: "abc",
        length: "short",
        paperTitle: "ABC Paper",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(usePodcastStore.getState().current?.arxiv_id).toBe("abc");

    // Now regenerate.
    await act(async () => {
      await usePodcastStore.getState().regenerate();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(api.deletePodcast).toHaveBeenCalledWith("abc", "short");
    expect(api.streamGenerate).toHaveBeenCalledTimes(2);
    // The second call should have been for the same arxiv_id and length.
    const secondCall = (api.streamGenerate as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCall.arxiv_id).toBe("abc");
    expect(secondCall.length).toBe("short");
  });
});

describe("podcast-store setPosition", () => {
  it("writes position to state and persists to localStorage", async () => {
    // Set up a current podcast first.
    (api.streamGenerate as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: unknown, h: { onEvent: (ev: api.PodcastEvent) => void; onDone?: () => void }) => {
        h.onEvent({
          type: "ready",
          url: "/api/podcast/p1/short.mp3",
          segments: [],
          duration_s: 60,
        });
        h.onDone?.();
      },
    );
    (api.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
      voice: "v",
      model: "m",
      segments: [],
      duration_s: 60,
      arxiv_id: "p1",
      length: "short",
      backend: "claude",
      generated_at: 0,
      script: "",
    });

    await act(async () => {
      await usePodcastStore.getState().generate({
        arxiv_id: "p1",
        length: "short",
        paperTitle: "Paper 1",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    act(() => {
      usePodcastStore.getState().setPosition(42.5);
    });

    expect(usePodcastStore.getState().position).toBe(42.5);

    // setPosition is debounced (~1s) to avoid hammering localStorage from
    // <audio>'s ~4Hz timeupdate event. Wait for the flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });

    const stored = JSON.parse(localStorage.getItem("atlas.podcast.session.v1") ?? "{}");
    expect(stored.position).toBe(42.5);
    expect(stored.arxiv_id).toBe("p1");
  });
});

describe("podcast-store close", () => {
  it("clears all state and removes localStorage entry", async () => {
    localStorage.setItem(
      "atlas.podcast.session.v1",
      JSON.stringify({ arxiv_id: "x", length: "short", paperTitle: "T", position: 5 }),
    );
    // Manually set some state to something non-default.
    usePodcastStore.setState({ generationState: "ready", scriptDraft: "hello", position: 5 });

    act(() => {
      usePodcastStore.getState().close();
    });

    const s = usePodcastStore.getState();
    expect(s.current).toBeNull();
    expect(s.generationState).toBe("idle");
    expect(s.scriptDraft).toBe("");
    expect(s.position).toBe(0);
    expect(s.isPlaying).toBe(false);
    expect(s.error).toBeNull();
    expect(localStorage.getItem("atlas.podcast.session.v1")).toBeNull();
  });
});

describe("podcast-store rehydrate", () => {
  it("sets current with segments and generationState=ready when manifest returns data", async () => {
    localStorage.setItem(
      "atlas.podcast.session.v1",
      JSON.stringify({ arxiv_id: "r1", length: "medium", paperTitle: "Rehydrated", position: 15 }),
    );
    (api.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
      voice: "af_sky",
      model: "sonnet",
      segments: [{ idx: 0, text: "hello", start_ms: 0, end_ms: 500 }],
      duration_s: 120,
      arxiv_id: "r1",
      length: "medium",
      backend: "claude",
      generated_at: 1000,
      script: "hello",
    });

    await act(async () => {
      await usePodcastStore.getState().rehydrate();
    });

    const s = usePodcastStore.getState();
    expect(s.generationState).toBe("ready");
    expect(s.current?.arxiv_id).toBe("r1");
    expect(s.current?.length).toBe("medium");
    expect(s.current?.paperTitle).toBe("Rehydrated");
    expect(s.current?.voice).toBe("af_sky");
    expect(s.current?.model).toBe("sonnet");
    expect(s.current?.segments).toHaveLength(1);
    expect(s.current?.url).toBe("/api/podcast/r1/medium.mp3");
    expect(s.position).toBe(15);
    expect(s.isPlaying).toBe(false);
  });

  it("silently clears persistence on 404 and leaves state unchanged", async () => {
    localStorage.setItem(
      "atlas.podcast.session.v1",
      JSON.stringify({ arxiv_id: "gone", length: "short", paperTitle: "Gone", position: 0 }),
    );
    (api.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await act(async () => {
      await usePodcastStore.getState().rehydrate();
    });

    const s = usePodcastStore.getState();
    // State stays at defaults (close() was called in beforeEach).
    expect(s.current).toBeNull();
    expect(s.generationState).toBe("idle");
    // Persistence should be cleared.
    expect(localStorage.getItem("atlas.podcast.session.v1")).toBeNull();
  });

  it("no-ops when there is no persisted entry", async () => {
    // localStorage is empty (cleared in beforeEach).
    await act(async () => {
      await usePodcastStore.getState().rehydrate();
    });

    expect(api.fetchManifest).not.toHaveBeenCalled();
    const s = usePodcastStore.getState();
    expect(s.current).toBeNull();
    expect(s.generationState).toBe("idle");
  });

  it("does not update state when fetchManifest throws (network error)", async () => {
    localStorage.setItem(
      "atlas.podcast.session.v1",
      JSON.stringify({ arxiv_id: "net-err", length: "long", paperTitle: "Net Error", position: 3 }),
    );
    (api.fetchManifest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network failure"));

    await act(async () => {
      await usePodcastStore.getState().rehydrate();
    });

    const s = usePodcastStore.getState();
    // State should stay at idle (no update on network error).
    expect(s.current).toBeNull();
    expect(s.generationState).toBe("idle");
    // localStorage entry preserved (we don't clear on network error).
    expect(localStorage.getItem("atlas.podcast.session.v1")).not.toBeNull();
  });
});

describe("podcast-store generate manifest fetch failure", () => {
  it("still sets current with empty voice/model when manifest fetch fails after ready", async () => {
    (api.streamGenerate as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: unknown, h: { onEvent: (ev: api.PodcastEvent) => void; onDone?: () => void }) => {
        h.onEvent({
          type: "ready",
          url: "/api/podcast/mfail/short.mp3",
          segments: [],
          duration_s: 5,
        });
        h.onDone?.();
      },
    );
    (api.fetchManifest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("manifest 503"));

    await act(async () => {
      await usePodcastStore.getState().generate({
        arxiv_id: "mfail",
        length: "short",
        paperTitle: "Manifest Fail",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    const s = usePodcastStore.getState();
    expect(s.generationState).toBe("ready");
    expect(s.current?.arxiv_id).toBe("mfail");
    expect(s.current?.voice).toBe("");
    expect(s.current?.model).toBe("");
  });
});
