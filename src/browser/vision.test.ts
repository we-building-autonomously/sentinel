import { describe, it, expect } from "vitest";
import { shouldUseVision, type PageSnapshot } from "./indexer.js";

function snap(over: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "https://e.com",
    title: "t",
    elements: [],
    text: "",
    rendered: "",
    hasCanvas: false,
    hasOpenDialog: false,
    ...over,
  };
}

const el = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ index: i, tag: "button", role: null, name: `b${i}`, inViewport: true }));

describe("shouldUseVision", () => {
  it("uses vision when there are no addressable elements", () => {
    expect(shouldUseVision(snap({ elements: [] }))).toBe(true);
  });

  it("uses vision for a canvas page with only a few chrome controls", () => {
    expect(shouldUseVision(snap({ elements: el(2), hasCanvas: true }))).toBe(true);
  });

  it("does NOT use vision for a normal rich DOM even with a small canvas", () => {
    expect(shouldUseVision(snap({ elements: el(20), hasCanvas: true }))).toBe(false);
  });

  it("does NOT use vision for a normal page without canvas", () => {
    expect(shouldUseVision(snap({ elements: el(5), hasCanvas: false }))).toBe(false);
  });
});
