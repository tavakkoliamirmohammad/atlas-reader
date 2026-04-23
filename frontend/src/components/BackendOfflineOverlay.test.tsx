import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BackendOfflineOverlay } from "./BackendOfflineOverlay";

// Force the probe to report "offline" so the overlay actually renders.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: false } as Response)),
  );
});

describe("BackendOfflineOverlay", () => {
  it("renders the current origin in the expected-backend hint", async () => {
    render(<BackendOfflineOverlay />);
    await waitFor(() => screen.getByRole("alertdialog"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent ?? "").toContain(window.location.origin);
    expect(dialog.textContent ?? "").not.toContain("localhost:8765");
  });

  it("tells the user to run `atlas up`, not `atlas start`", async () => {
    render(<BackendOfflineOverlay />);
    await waitFor(() => screen.getByRole("alertdialog"));
    expect(screen.getByLabelText(/command to start atlas/i).textContent).toMatch(/atlas up/);
  });
});
