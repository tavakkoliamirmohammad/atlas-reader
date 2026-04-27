import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickActionChips } from "./QuickActionChips";

const noop = () => {};

describe("QuickActionChips – Listen chip", () => {
  it("is hidden when onListen is not passed", () => {
    render(
      <QuickActionChips
        onSummarize={noop}
        onQuickAsk={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Listen/i })).toBeNull();
  });

  it("is enabled when listenDisabledReason is undefined", () => {
    render(
      <QuickActionChips
        onSummarize={noop}
        onQuickAsk={noop}
        onListen={noop}
      />,
    );
    const btn = screen.getByRole("button", { name: /Listen/i });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute("title");
  });

  it("is disabled and shows tooltip when listenDisabledReason is set", () => {
    render(
      <QuickActionChips
        onSummarize={noop}
        onQuickAsk={noop}
        onListen={noop}
        listenDisabledReason="TTS service offline."
      />,
    );
    const btn = screen.getByRole("button", { name: /Listen/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "TTS service offline.");
  });

  it("clicking Listen opens length picker with Short/Medium/Long options", () => {
    render(
      <QuickActionChips
        onSummarize={noop}
        onQuickAsk={noop}
        onListen={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Listen/i }));
    expect(screen.getByRole("menuitem", { name: /Short/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Medium/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Long/i })).toBeInTheDocument();
  });

  it("clicking a length fires onListen with that value and closes picker", () => {
    const onListen = vi.fn();
    render(
      <QuickActionChips
        onSummarize={noop}
        onQuickAsk={noop}
        onListen={onListen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Listen/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Short/i }));

    expect(onListen).toHaveBeenCalledWith("short");
    // Picker should be closed after selection.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking Medium fires onListen with 'medium'", () => {
    const onListen = vi.fn();
    render(
      <QuickActionChips
        onSummarize={noop}
        onQuickAsk={noop}
        onListen={onListen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Listen/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Medium/i }));

    expect(onListen).toHaveBeenCalledWith("medium");
  });

  it("clicking Long fires onListen with 'long'", () => {
    const onListen = vi.fn();
    render(
      <QuickActionChips
        onSummarize={noop}
        onQuickAsk={noop}
        onListen={onListen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Listen/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Long/i }));

    expect(onListen).toHaveBeenCalledWith("long");
  });
});
