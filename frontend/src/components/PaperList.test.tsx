import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/stores/ui-store";
import { PaperList } from "./PaperList";

vi.mock("@/lib/api", () => ({
  api: {
    health: vi.fn(),
    digest: vi.fn(async () => ({ count: 0, papers: [] })),
    paper: vi.fn(),
    pdfUrl: (id: string) => `/api/pdf/${id}`,
  },
}));

describe("PaperList range selector", () => {
  beforeEach(() => {
    useUiStore.setState({ digestRange: 7 });
  });

  it("renders five range tabs and updates the store on click", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PaperList />
      </MemoryRouter>,
    );

    for (const label of ["3d", "7d", "14d", "30d", "All"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }

    await user.click(screen.getByRole("tab", { name: "30d" }));
    expect(useUiStore.getState().digestRange).toBe(30);
  });
});
