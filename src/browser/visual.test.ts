import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import { compareScreenshots, formatVisual } from "./visual.js";

/** Build a solid-color PNG buffer, optionally with one pixel of a different color. */
function png(width: number, height: number, color: [number, number, number], dirtyPixels = 0): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    p.data[o] = color[0];
    p.data[o + 1] = color[1];
    p.data[o + 2] = color[2];
    p.data[o + 3] = 255;
  }
  for (let i = 0; i < dirtyPixels; i++) {
    const o = i * 4;
    p.data[o] = 255 - color[0];
    p.data[o + 1] = 255 - color[1];
    p.data[o + 2] = 255 - color[2];
  }
  return PNG.sync.write(p);
}

describe("compareScreenshots", () => {
  it("reports a match for identical images", () => {
    const a = png(20, 20, [10, 20, 30]);
    const r = compareScreenshots(a, png(20, 20, [10, 20, 30]));
    expect(r.status).toBe("match");
    expect(r.mismatchedPixels).toBe(0);
    expect(r.diffPng).toBeUndefined();
  });

  it("flags a diff when too many pixels change, and emits a diff image", () => {
    // 20x20 = 400 px; flip 40 (10%), well over the 1% default threshold.
    const r = compareScreenshots(png(20, 20, [0, 0, 0]), png(20, 20, [0, 0, 0], 40));
    expect(r.status).toBe("diff");
    expect(r.mismatchedPixels).toBeGreaterThanOrEqual(40);
    expect(r.diffRatio).toBeGreaterThan(0.01);
    expect(Buffer.isBuffer(r.diffPng)).toBe(true);
  });

  it("treats a tiny change under maxDiffRatio as a match", () => {
    // 1 changed px of 400 = 0.25% < 1% default.
    const r = compareScreenshots(png(20, 20, [0, 0, 0]), png(20, 20, [0, 0, 0], 1));
    expect(r.status).toBe("match");
  });

  it("honors a custom maxDiffRatio", () => {
    const r = compareScreenshots(png(20, 20, [0, 0, 0]), png(20, 20, [0, 0, 0], 1), { maxDiffRatio: 0 });
    expect(r.status).toBe("diff");
  });

  it("detects a size mismatch as a regression", () => {
    const r = compareScreenshots(png(20, 20, [0, 0, 0]), png(20, 40, [0, 0, 0]));
    expect(r.status).toBe("size-mismatch");
    expect(r.sizes).toEqual({ baseline: [20, 20], current: [20, 40] });
  });
});

describe("formatVisual", () => {
  it("labels each status", () => {
    expect(formatVisual({ status: "match", mismatchedPixels: 0, totalPixels: 1, diffRatio: 0 })).toBe("matches baseline");
    expect(formatVisual({ status: "new-baseline", mismatchedPixels: 0, totalPixels: 1, diffRatio: 0 })).toContain("new baseline");
    expect(
      formatVisual({ status: "diff", mismatchedPixels: 40, totalPixels: 400, diffRatio: 0.1 })
    ).toContain("10.00%");
  });
});
