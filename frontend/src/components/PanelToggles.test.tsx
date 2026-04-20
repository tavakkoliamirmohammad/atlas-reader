import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PanelToggles } from "./PanelToggles";
import { useUiStore } from "@/stores/ui-store";

describe("PanelToggles", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ paletteId: "cyan-emerald", leftCollapsed: false, rightCollapsed: false, readingMode: "light" });
  });

  it("toggles the left panel when List button clicked", () => {
    render(<PanelToggles />);
    fireEvent.click(screen.getByRole("button", { name: /toggle left panel/i }));
    expect(useUiStore.getState().leftCollapsed).toBe(true);
  });

  it("toggles the right panel when Chat button clicked", () => {
    render(<PanelToggles />);
    fireEvent.click(screen.getByRole("button", { name: /toggle right panel/i }));
    expect(useUiStore.getState().rightCollapsed).toBe(true);
  });
});
