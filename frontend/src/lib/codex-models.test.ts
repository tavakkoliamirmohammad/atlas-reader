import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCodexModels } from "./api";

const ORIGINAL_FETCH = globalThis.fetch;

describe("getCodexModels", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns the model list from /api/models?backend=codex", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { slug: "gpt-5.5", label: "GPT-5.5", description: "frontier" },
          { slug: "gpt-5.4", label: "GPT-5.4", description: "current" },
        ],
      }),
    });

    const out = await getCodexModels();
    expect(out).toEqual([
      { slug: "gpt-5.5", label: "GPT-5.5", description: "frontier" },
      { slug: "gpt-5.4", label: "GPT-5.4", description: "current" },
    ]);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/api/models?backend=codex");
  });

  it("throws when the endpoint returns a non-200 status", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "codex models cache not found",
    });

    await expect(getCodexModels()).rejects.toThrow(/503/);
  });
});
