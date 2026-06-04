import { describe, it, expect } from "vitest";
import { hasHorizontalOverflow } from "./layout.js";

describe("hasHorizontalOverflow", () => {
  it("is false when the document fits the viewport", () => {
    expect(hasHorizontalOverflow({ scrollWidth: 390, clientWidth: 390 })).toBe(false);
  });

  it("tolerates a few px of sub-pixel / scrollbar slop", () => {
    expect(hasHorizontalOverflow({ scrollWidth: 392, clientWidth: 390 })).toBe(false); // 2px
  });

  it("flags a real horizontal overflow", () => {
    expect(hasHorizontalOverflow({ scrollWidth: 800, clientWidth: 390 })).toBe(true);
  });
});
