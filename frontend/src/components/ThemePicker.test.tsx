import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemePicker } from "./ThemePicker";
import { useUiStore } from "@/stores/ui-store";

describe("ThemePicker", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ paletteId: "cyan-emerald", customPalette: null, leftCollapsed: false, rightCollapsed: false, readingMode: "light" });
  });

  it("renders a dot for each of the 6 presets plus a custom slot", () => {
    render(<ThemePicker />);
    expect(screen.getAllByRole("button", { name: /palette/i })).toHaveLength(7);
  });

  it("clicking a palette dot updates the store", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /sky \/ indigo palette/i }));
    expect(useUiStore.getState().paletteId).toBe("sky-indigo");
  });

  it("marks the active palette with aria-pressed=true", () => {
    render(<ThemePicker />);
    const cyan = screen.getByRole("button", { name: /cyan \/ emerald palette/i });
    expect(cyan).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking the custom dot opens the popover when no custom palette is set", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /custom palette/i }));
    expect(screen.getByRole("dialog", { name: /custom palette editor/i })).toBeInTheDocument();
  });

  it("saving the popover persists customPalette and switches paletteId to custom", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /custom palette/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    const state = useUiStore.getState();
    expect(state.paletteId).toBe("custom");
    expect(state.customPalette).not.toBeNull();
  });
});
