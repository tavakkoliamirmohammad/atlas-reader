import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/stores/ui-store";
import { ChatPanel } from "./ChatPanel";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    streamAsk: vi.fn(async (_id, question, _history, handlers) => {
      (handlers as { onChunk: (s: string) => void; onDone: () => void }).onChunk(
        `echo:${question}`,
      );
      (handlers as { onDone: () => void }).onDone();
    }),
    streamSummary: vi.fn(),
    fetchGlossary: vi.fn(async () => []),
  };
});

function renderInReader() {
  return render(
    <MemoryRouter initialEntries={["/reader/abc"]}>
      <Routes>
        <Route path="/reader/:arxivId" element={<ChatPanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatPanel pinned quote", () => {
  beforeEach(() => {
    useUiStore.setState({ pinnedQuote: null });
    // jsdom doesn't implement scrollIntoView; StreamingMessage calls it on mount.
    if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
  });

  it("renders the pinned-quote chip when set and prepends on send", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      pinnedQuote: { text: "Tensor cores saturate here", page: 4 },
    });

    renderInReader();

    expect(screen.getByText(/Tensor cores saturate here/)).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/Ask anything about this paper/i);
    await user.type(textarea, "why?");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const { streamAsk } = await import("@/lib/api");
    expect(streamAsk).toHaveBeenCalled();
    const callArg = (streamAsk as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(callArg).toContain("Tensor cores saturate here");
    expect(callArg).toContain("why?");

    // Chip cleared after send.
    expect(useUiStore.getState().pinnedQuote).toBeNull();
  });
});

describe("ChatPanel Enter / Shift+Enter", () => {
  beforeEach(() => {
    useUiStore.setState({ pinnedQuote: null });
    if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
    vi.clearAllMocks();
  });

  it("Enter sends the message", async () => {
    const user = userEvent.setup();
    renderInReader();
    const textarea = screen.getByPlaceholderText(/Ask anything about this paper/i);
    await user.type(textarea, "what is this?");
    await user.keyboard("{Enter}");

    const { streamAsk } = await import("@/lib/api");
    expect(streamAsk).toHaveBeenCalled();
    const sentText = (streamAsk as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sentText).toContain("what is this?");
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const user = userEvent.setup();
    renderInReader();
    const textarea = screen.getByPlaceholderText(/Ask anything about this paper/i) as HTMLTextAreaElement;
    await user.type(textarea, "line1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(textarea, "line2");

    const { streamAsk } = await import("@/lib/api");
    expect(streamAsk).not.toHaveBeenCalled();
    expect(textarea.value).toBe("line1\nline2");
  });
});
