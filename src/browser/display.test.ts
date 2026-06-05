import { describe, it, expect } from "vitest";
import { selectForDisplay, renderElements, type ElementInfo } from "./indexer.js";

function els(n: number, inViewport: (i: number) => boolean): ElementInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    tag: "button",
    role: null,
    name: `b${i}`,
    inViewport: inViewport(i),
  }));
}

describe("selectForDisplay", () => {
  it("returns everything unchanged when under the cap", () => {
    const e = els(10, () => true);
    const { shown, omitted } = selectForDisplay(e, 120);
    expect(shown).toHaveLength(10);
    expect(omitted).toBe(0);
  });

  it("caps and reports the omitted count", () => {
    const e = els(200, () => true);
    const { shown, omitted } = selectForDisplay(e, 120);
    expect(shown).toHaveLength(120);
    expect(omitted).toBe(80);
  });

  it("prioritizes in-viewport elements when capping", () => {
    // 50 in-viewport (indices 100..149), 150 off-viewport (0..99,150..199).
    const e = els(200, (i) => i >= 100 && i < 150);
    const { shown } = selectForDisplay(e, 60);
    const inViewShown = shown.filter((x) => x.inViewport).length;
    expect(inViewShown).toBe(50); // all in-view kept
    expect(shown).toHaveLength(60); // plus 10 off-view to fill the cap
  });

  it("keeps shown elements in original index order", () => {
    const e = els(300, (i) => i % 2 === 0);
    const { shown } = selectForDisplay(e, 100);
    const idxs = shown.map((s) => s.index);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
  });
});

describe("renderElements dialog marker", () => {
  it("marks elements inside an open modal", () => {
    const out = renderElements([
      { index: 0, tag: "button", role: null, name: "Revoke", inViewport: true, inDialog: true },
      { index: 1, tag: "a", role: null, name: "Settings", inViewport: true },
    ]);
    expect(out).toContain('[0] <button> "Revoke" (in dialog)');
    expect(out).not.toContain('[1] <a> "Settings" (in dialog)');
  });
});

describe("renderElements row context", () => {
  it("disambiguates repeated controls with their row text", () => {
    const out = renderElements([
      { index: 0, tag: "button", role: null, name: "Revoke", inViewport: true, context: "sentinel-qa-test tok_9528… active" },
      { index: 1, tag: "button", role: null, name: "Revoke", inViewport: true, context: "claude tok_8b8a… active" },
    ]);
    expect(out).toContain('[0] <button> "Revoke" (in "sentinel-qa-test');
    expect(out).toContain('[1] <button> "Revoke" (in "claude');
  });
});
