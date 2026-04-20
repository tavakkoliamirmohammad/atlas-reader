import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useGlobalShortcuts } from "./keyboard";
import { useUiStore } from "@/stores/ui-store";

function Harness() {
  useGlobalShortcuts();
  return <div tabIndex={-1}>ready</div>;
}

describe("useGlobalShortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ paletteId: "cyan-emerald", leftCollapsed: false, rightCollapsed: false, readingMode: "light" });
  });

  it("toggles left panel on '['", async () => {
    render(<Harness />);
    await userEvent.keyboard("[[");
    expect(useUiStore.getState().leftCollapsed).toBe(true);
  });

  it("toggles right panel on ']'", async () => {
    render(<Harness />);
    await userEvent.keyboard("]");
    expect(useUiStore.getState().rightCollapsed).toBe(true);
  });

  it("ignores keys when an input is focused", async () => {
    render(
      <>
        <input data-testid="textbox" />
        <Harness />
      </>,
    );
    const input = document.querySelector<HTMLInputElement>("[data-testid='textbox']")!;
    input.focus();
    await userEvent.keyboard("[[");
    expect(useUiStore.getState().leftCollapsed).toBe(false);
  });
});
