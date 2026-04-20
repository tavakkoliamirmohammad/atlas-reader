import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectionToolbar } from "./SelectionToolbar";

describe("SelectionToolbar", () => {
  it("fires onHighlight with the current color when Highlight clicked", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn();
    render(
      <SelectionToolbar
        left={100}
        top={50}
        color="yellow"
        onHighlight={onHighlight}
        onAsk={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^highlight$/i }));
    expect(onHighlight).toHaveBeenCalledWith("yellow");
  });

  it("fires onAsk when Ask clicked", async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(
      <SelectionToolbar
        left={0}
        top={0}
        color="yellow"
        onHighlight={() => {}}
        onAsk={onAsk}
      />,
    );
    await user.click(screen.getByRole("button", { name: /ask/i }));
    expect(onAsk).toHaveBeenCalled();
  });

  it("cycles the default color yellow -> coral when the swatch is clicked", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn();
    render(
      <SelectionToolbar
        left={0}
        top={0}
        color="yellow"
        onHighlight={onHighlight}
        onAsk={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cycle color/i }));
    await user.click(screen.getByRole("button", { name: /^highlight$/i }));
    expect(onHighlight).toHaveBeenCalledWith("coral");
  });
});
