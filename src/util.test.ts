import { describe, it, expect } from "vitest";
import { slugify, trimLine, errMsg } from "./util.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("User can Sign Up!")).toBe("user-can-sign-up");
  });
  it("trims leading/trailing separators", () => {
    expect(slugify("  --Hello, World--  ")).toBe("hello-world");
  });
  it("caps length to 40 chars", () => {
    expect(slugify("a".repeat(100)).length).toBe(40);
  });
});

describe("trimLine", () => {
  it("collapses whitespace", () => {
    expect(trimLine("a   b\n\tc")).toBe("a b c");
  });
  it("truncates with ellipsis past the limit", () => {
    expect(trimLine("abcdef", 3)).toBe("abc…");
  });
  it("handles nullish input", () => {
    expect(trimLine(undefined as unknown as string)).toBe("");
  });
});

describe("errMsg", () => {
  it("takes the first line of an Error", () => {
    expect(errMsg(new Error("boom\nstack trace here"))).toBe("boom");
  });
  it("stringifies non-errors", () => {
    expect(errMsg("plain")).toBe("plain");
  });
});
