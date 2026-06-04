import { describe, it, expect } from "vitest";
import { obsSig, observationUnchanged } from "./loop.js";
import type { PageSnapshot } from "../browser/indexer.js";

function snap(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://e.com",
    title: "Home",
    elements: [{ index: 0, tag: "button", role: null, name: "Go", inViewport: true }],
    text: "hello",
    rendered: '[0] <button> "Go"',
    hasCanvas: false,
    hasOpenDialog: false,
    ...over,
  };
}

describe("obsSig", () => {
  it("is identical for identical url/title/rendered", () => {
    expect(obsSig(snap())).toBe(obsSig(snap()));
  });
  it("differs when the rendered element list changes", () => {
    expect(obsSig(snap())).not.toBe(obsSig(snap({ rendered: '[0] <button> "Stop"' })));
  });
  it("differs when the url changes (ignores body text)", () => {
    expect(obsSig(snap())).not.toBe(obsSig(snap({ url: "https://e.com/next" })));
    // body text alone is not part of the signature
    expect(obsSig(snap())).toBe(obsSig(snap({ text: "different body text" })));
  });
});

describe("observationUnchanged", () => {
  it("is false with no previous signature", () => {
    expect(observationUnchanged(null, snap())).toBe(false);
  });
  it("is true when the new observation matches the previous", () => {
    expect(observationUnchanged(obsSig(snap()), snap())).toBe(true);
  });
  it("is false when the page changed", () => {
    expect(observationUnchanged(obsSig(snap()), snap({ rendered: "[0] <a> x" }))).toBe(false);
  });
  it("never collapses a vision-mode observation", () => {
    const visionSnap = snap({ elements: [], rendered: "(none detected)", hasCanvas: true });
    // identical sig, but vision mode forces a full (screenshot-bearing) observation
    expect(observationUnchanged(obsSig(visionSnap), visionSnap)).toBe(false);
  });
});
