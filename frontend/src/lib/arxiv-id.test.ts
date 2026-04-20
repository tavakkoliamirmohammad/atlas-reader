import { describe, it, expect } from "vitest";
import { parseArxivId } from "./arxiv-id";

describe("parseArxivId", () => {
  it("extracts ID from a full abs URL", () => {
    expect(parseArxivId("https://arxiv.org/abs/2404.12345")).toBe("2404.12345");
  });
  it("extracts ID from a versioned URL", () => {
    expect(parseArxivId("https://arxiv.org/abs/2404.12345v3")).toBe("2404.12345");
  });
  it("extracts ID from a pdf URL", () => {
    expect(parseArxivId("https://arxiv.org/pdf/2404.12345v2.pdf")).toBe("2404.12345");
  });
  it("accepts a bare ID", () => {
    expect(parseArxivId("2404.12345")).toBe("2404.12345");
  });
  it("accepts an old-style ID like cs.PL/0501001", () => {
    expect(parseArxivId("cs.PL/0501001")).toBe("cs.PL/0501001");
  });
  it("returns null for garbage", () => {
    expect(parseArxivId("hello world")).toBeNull();
    expect(parseArxivId("")).toBeNull();
  });
});
