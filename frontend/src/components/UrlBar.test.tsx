import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UrlBar } from "./UrlBar";

describe("UrlBar", () => {
  it("calls onSubmit with parsed arxiv id when valid URL submitted", () => {
    const onSubmit = vi.fn();
    render(<UrlBar onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/arxiv url/i);
    fireEvent.change(input, { target: { value: "https://arxiv.org/abs/2404.12345v2" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onSubmit).toHaveBeenCalledWith("2404.12345");
  });

  it("calls onSubmit with bare ID", () => {
    const onSubmit = vi.fn();
    render(<UrlBar onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/arxiv url/i);
    fireEvent.change(input, { target: { value: "2404.12345" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("2404.12345");
  });

  it("does not call onSubmit when input is invalid", () => {
    const onSubmit = vi.fn();
    render(<UrlBar onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/arxiv url/i);
    fireEvent.change(input, { target: { value: "garbage" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
