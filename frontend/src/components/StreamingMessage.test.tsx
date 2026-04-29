import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StreamingMessage } from "./StreamingMessage";
import { useUiActionsStore } from "@/stores/ui-actions-store";

describe("StreamingMessage page-link interceptor", () => {
  it("renders [Sec. 4.2 (p.7)](page:7) as a button that jumps the viewer", async () => {
    const user = userEvent.setup();
    const requestSpy = vi.spyOn(useUiActionsStore.getState(), "requestJumpToPage");

    render(
      <StreamingMessage
        role="assistant"
        content="The pass is described in [Sec. 4.2 (p.7)](page:7)."
      />,
    );

    const link = screen.getByRole("button", { name: /Sec\. 4\.2 \(p\.7\)/ });
    await user.click(link);
    expect(requestSpy).toHaveBeenCalledWith(7);
  });

  it("leaves real http links as <a> tags", () => {
    render(
      <StreamingMessage
        role="assistant"
        content="See [arxiv](https://arxiv.org/abs/2501.00001) for context."
      />,
    );
    const link = screen.getByRole("link", { name: "arxiv" });
    expect(link).toHaveAttribute("href", "https://arxiv.org/abs/2501.00001");
  });
});
