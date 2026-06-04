import { describe, it, expect } from "vitest";
import { shouldVisionJudge } from "./judge.js";
import type { TestSpec } from "../types.js";

function spec(over: Partial<TestSpec> = {}): TestSpec {
  return { title: "t", task: "do it", intent: "it works", app: { url: "http://x" }, ...over };
}

describe("shouldVisionJudge", () => {
  it("is false for a purely functional test", () => {
    expect(shouldVisionJudge(spec({ task: "log in", intent: "the user reaches the dashboard" }))).toBe(false);
  });

  it("is true when the intent is about appearance/layout", () => {
    expect(shouldVisionJudge(spec({ intent: "the cards are aligned in a grid" }))).toBe(true);
    expect(shouldVisionJudge(spec({ task: "check the page renders correctly" }))).toBe(true);
    expect(shouldVisionJudge(spec({ intent: "no elements overlap on mobile" }))).toBe(true);
    expect(shouldVisionJudge(spec({ intent: "the header color is blue" }))).toBe(true);
  });

  it("is true when visual regression is enabled regardless of wording", () => {
    expect(shouldVisionJudge(spec({ intent: "anything", visual: true }))).toBe(true);
  });

  it("considers the criteria list too", () => {
    expect(shouldVisionJudge(spec({ criteria: ["the logo is aligned to the top-left"] }))).toBe(true);
  });

  it("does not over-trigger on unrelated words", () => {
    expect(shouldVisionJudge(spec({ task: "submit the form", intent: "a confirmation appears" }))).toBe(false);
  });
});
