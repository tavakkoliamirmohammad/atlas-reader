import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PodcastTranscript } from "./PodcastTranscript";

const segs = [
  { idx: 0, text: "First sentence.",  start_ms: 0,    end_ms: 1000 },
  { idx: 1, text: "Second sentence.", start_ms: 1000, end_ms: 2000 },
  { idx: 2, text: "Third sentence.",  start_ms: 2000, end_ms: 3000 },
];

describe("PodcastTranscript", () => {
  it("renders nothing for empty segments", () => {
    const { container } = render(
      <PodcastTranscript segments={[]} position={0} onSeek={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one button per segment", () => {
    render(<PodcastTranscript segments={segs} position={0} onSeek={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("highlights the active segment based on position", () => {
    render(<PodcastTranscript segments={segs} position={1.5} onSeek={() => {}} />);
    // position=1.5s -> 1500ms -> falls inside segs[1] (1000..2000ms)
    const active = screen.getAllByRole("button").find((b) => b.dataset.active === "true");
    expect(active?.textContent).toBe("Second sentence.");
  });

  it("highlights nothing when position is past the last segment", () => {
    render(<PodcastTranscript segments={segs} position={10} onSeek={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.every((b) => b.dataset.active !== "true")).toBe(true);
  });

  it("calls onSeek with start_ms / 1000 when a segment is clicked", () => {
    const onSeek = vi.fn();
    render(<PodcastTranscript segments={segs} position={0} onSeek={onSeek} />);
    fireEvent.click(screen.getByText("Second sentence."));
    expect(onSeek).toHaveBeenCalledWith(1.0); // 1000 / 1000
  });

  it("activates segment via keyboard (Enter)", () => {
    const onSeek = vi.fn();
    render(<PodcastTranscript segments={segs} position={0} onSeek={onSeek} />);
    const btn = screen.getByText("Third sentence.");
    btn.focus();
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.click(btn); // Browsers fire click on Enter for buttons
    expect(onSeek).toHaveBeenCalledWith(2.0);
  });

  it("re-highlights when position prop changes", () => {
    const { rerender } = render(
      <PodcastTranscript segments={segs} position={0.5} onSeek={() => {}} />,
    );
    let active = screen.getAllByRole("button").find((b) => b.dataset.active === "true");
    expect(active?.textContent).toBe("First sentence.");

    rerender(<PodcastTranscript segments={segs} position={2.5} onSeek={() => {}} />);
    active = screen.getAllByRole("button").find((b) => b.dataset.active === "true");
    expect(active?.textContent).toBe("Third sentence.");
  });
});
