import { describe, it, expect } from "vitest";
import { looksLoading } from "./loading.js";

describe("looksLoading", () => {
  it("is true for an aria-busy / progressbar page", () => {
    expect(looksLoading({ ariaBusy: true, interactive: 20, text: "Dashboard" })).toBe(true);
  });

  it("is true for a near-empty page whose text is just 'Loading…'", () => {
    expect(looksLoading({ ariaBusy: false, interactive: 0, text: "Loading…" })).toBe(true);
    expect(looksLoading({ ariaBusy: false, interactive: 1, text: "Loading..." })).toBe(true);
    expect(looksLoading({ ariaBusy: false, interactive: 2, text: "Please wait" })).toBe(true);
  });

  it("is false once the page has real interactive content", () => {
    expect(looksLoading({ ariaBusy: false, interactive: 12, text: "Loading… (stale text)" })).toBe(false);
  });

  it("is false for a normal page", () => {
    expect(looksLoading({ ariaBusy: false, interactive: 8, text: "Sign in to your account" })).toBe(false);
  });

  it("does not trip on 'loading' appearing mid-sentence", () => {
    expect(looksLoading({ ariaBusy: false, interactive: 1, text: "Tips for loading data faster" })).toBe(false);
  });
});
