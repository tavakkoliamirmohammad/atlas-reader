import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MiniAudioPlayer } from "./MiniAudioPlayer";
import { usePodcastStore } from "@/stores/podcast-store";

// ---------------------------------------------------------------------------
// Audio element mocks — jsdom doesn't implement media APIs.
// ---------------------------------------------------------------------------
vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

// ---------------------------------------------------------------------------
// A complete ready-state `current` fixture used by many tests.
// ---------------------------------------------------------------------------
const fakeCurrent = {
  arxiv_id: "2401.00001",
  length: "short" as const,
  paperTitle: "Attention Is All You Need",
  url: "http://localhost/fake.mp3",
  segments: [],
  duration_s: 300,
  voice: "alloy",
  model: "tts-1",
  origBackend: undefined,
  origModel: undefined,
};

// ---------------------------------------------------------------------------
// Reset store before every test.
// ---------------------------------------------------------------------------
const initialState = usePodcastStore.getState();

beforeEach(() => {
  usePodcastStore.setState({
    ...initialState,
    current: null,
    generationState: "idle",
    scriptDraft: "",
    progress: { synthesized_s: 0, total_s_estimate: 0 },
    error: null,
    position: 0,
    isPlaying: false,
  });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MiniAudioPlayer", () => {
  it("renders nothing when idle and no current", () => {
    const { container } = render(<MiniAudioPlayer />);
    expect(container.firstChild).toBeNull();
  });

  it("renders scripting state with drafting text", () => {
    usePodcastStore.setState({ generationState: "scripting" });
    render(<MiniAudioPlayer />);
    expect(screen.getByText(/Drafting script/i)).toBeInTheDocument();
  });

  it("renders synthesizing state with progress text", () => {
    usePodcastStore.setState({
      generationState: "synthesizing",
      progress: { synthesized_s: 30, total_s_estimate: 120 },
    });
    render(<MiniAudioPlayer />);
    expect(screen.getByText(/Generating audio/i)).toBeInTheDocument();
    // The time text "0:30 of ~2:00" should appear somewhere.
    expect(screen.getByText(/0:30/)).toBeInTheDocument();
  });

  it("renders full player when ready", () => {
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      position: 0,
      isPlaying: false,
    });
    render(<MiniAudioPlayer />);

    expect(screen.getByRole("button", { name: /Play/i })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /Seek/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Regenerate/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Close/i })).toBeInTheDocument();
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText(/alloy · tts-1/i)).toBeInTheDocument();
  });

  it("play button toggles audio play and pause", () => {
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      position: 0,
      isPlaying: false,
    });
    render(<MiniAudioPlayer />);

    const playBtn = screen.getByRole("button", { name: /Play/i });
    fireEvent.click(playBtn);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    // Simulate the browser firing the `play` event so isPlaying becomes true
    // and the button re-labels to "Pause". Wrap in act so React re-renders.
    act(() => {
      usePodcastStore.setState({ isPlaying: true });
    });
    const pauseBtn = screen.getByRole("button", { name: /Pause/i });
    fireEvent.click(pauseBtn);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  });

  it("scrubber commits seek on change and updates store position", () => {
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      position: 0,
      isPlaying: false,
    });
    render(<MiniAudioPlayer />);

    const scrubber = screen.getByRole("slider", { name: /Seek/i });
    fireEvent.change(scrubber, { target: { value: "10" } });

    // The store's position should be updated.
    expect(usePodcastStore.getState().position).toBe(10);
  });

  it("regenerate button calls store.regenerate", () => {
    const regenerateSpy = vi.fn();
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      regenerate: regenerateSpy,
    });
    render(<MiniAudioPlayer />);

    fireEvent.click(screen.getByRole("button", { name: /Regenerate/i }));
    expect(regenerateSpy).toHaveBeenCalledTimes(1);
  });

  it("close button calls store.close", () => {
    const closeSpy = vi.fn();
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      close: closeSpy,
    });
    render(<MiniAudioPlayer />);

    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("error state shows message and dismiss/retry buttons", () => {
    usePodcastStore.setState({
      generationState: "error",
      error: { phase: "tts", message: "service down" },
      current: fakeCurrent,
    });
    render(<MiniAudioPlayer />);

    expect(screen.getByText(/tts/i)).toBeInTheDocument();
    expect(screen.getByText(/service down/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dismiss/i })).toBeInTheDocument();
  });

  it("transcript chevron toggles local open state via aria-expanded", () => {
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      position: 0,
      isPlaying: false,
    });
    render(<MiniAudioPlayer />);

    const chevron = screen.getByTestId("transcript-chevron");
    // Initially closed.
    expect(chevron).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "false");
  });

  it("playback rate button cycles through 1x, 1.25x, 1.5x, 2x and back", () => {
    localStorage.removeItem("atlas.podcast.rate.v1");
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      position: 0,
      isPlaying: false,
    });
    render(<MiniAudioPlayer />);

    const btn = screen.getByTestId("playback-rate");
    expect(btn).toHaveTextContent("1×");

    fireEvent.click(btn);
    expect(btn).toHaveTextContent("1.25×");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("1.5×");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("2×");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("1×");
  });

  it("playback rate persists across remounts via localStorage", () => {
    localStorage.setItem("atlas.podcast.rate.v1", "1.5");
    usePodcastStore.setState({
      current: fakeCurrent,
      generationState: "ready",
      position: 0,
      isPlaying: false,
    });
    render(<MiniAudioPlayer />);
    expect(screen.getByTestId("playback-rate")).toHaveTextContent("1.5×");
  });
});
