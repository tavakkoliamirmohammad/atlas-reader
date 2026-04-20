import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemePicker } from "./ThemePicker";
import { useUiStore } from "@/stores/ui-store";

describe("ThemePicker", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ paletteId: "cyan-emerald", leftCollapsed: false, rightCollapsed: false, readingMode: "light" });
  });

  it("renders a dot for each of the 6 palettes", () => {
    render(<ThemePicker />);
    expect(screen.getAllByRole("button", { name: /palette/i })).toHaveLength(6);
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
});
