import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store";

describe("ui-store", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      paletteId: "cyan-emerald",
      leftCollapsed: false,
      rightCollapsed: false,
      readingMode: "light",
    });
  });

  it("defaults to cyan-emerald palette and expanded panels", () => {
    const s = useUiStore.getState();
    expect(s.paletteId).toBe("cyan-emerald");
    expect(s.leftCollapsed).toBe(false);
    expect(s.rightCollapsed).toBe(false);
    expect(s.readingMode).toBe("light");
  });

  it("setPalette updates state", () => {
    useUiStore.getState().setPalette("sky-indigo");
    expect(useUiStore.getState().paletteId).toBe("sky-indigo");
  });

  it("toggleLeft and toggleRight flip booleans", () => {
    useUiStore.getState().toggleLeft();
    expect(useUiStore.getState().leftCollapsed).toBe(true);
    useUiStore.getState().toggleRight();
    expect(useUiStore.getState().rightCollapsed).toBe(true);
    useUiStore.getState().toggleLeft();
    expect(useUiStore.getState().leftCollapsed).toBe(false);
  });

  it("setReadingMode accepts light, sepia, dark", () => {
    useUiStore.getState().setReadingMode("sepia");
    expect(useUiStore.getState().readingMode).toBe("sepia");
    useUiStore.getState().setReadingMode("dark");
    expect(useUiStore.getState().readingMode).toBe("dark");
  });

  it("persists to localStorage under atlas-ui key", () => {
    useUiStore.getState().setPalette("amber-orange");
    const raw = localStorage.getItem("atlas-ui");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.paletteId).toBe("amber-orange");
  });
});
