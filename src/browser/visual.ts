import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export type VisualStatus = "match" | "diff" | "size-mismatch" | "new-baseline";

export interface VisualResult {
  status: VisualStatus;
  /** Pixels that differed (0 for size-mismatch/new-baseline). */
  mismatchedPixels: number;
  /** Total pixels compared. */
  totalPixels: number;
  /** mismatchedPixels / totalPixels (0..1). */
  diffRatio: number;
  /** PNG buffer highlighting the differences (only when status === "diff"). */
  diffPng?: Buffer;
  /** Present for size-mismatch: the two sizes. */
  sizes?: { baseline: [number, number]; current: [number, number] };
}

export interface VisualOptions {
  /** Per-pixel color tolerance (0..1, higher = more lenient). Default 0.1. */
  threshold?: number;
  /** Max fraction of differing pixels before it counts as a regression. Default 0.01. */
  maxDiffRatio?: number;
}

/**
 * Compare a current screenshot against a baseline, pixel by pixel. Pure over
 * PNG buffers (no disk), so it's deterministic and testable. A size change is
 * itself a regression (the layout reflowed).
 */
export function compareScreenshots(
  baseline: Buffer,
  current: Buffer,
  opts: VisualOptions = {}
): VisualResult {
  const threshold = opts.threshold ?? 0.1;
  const maxDiffRatio = opts.maxDiffRatio ?? 0.01;
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);

  if (a.width !== b.width || a.height !== b.height) {
    return {
      status: "size-mismatch",
      mismatchedPixels: 0,
      totalPixels: a.width * a.height,
      diffRatio: 1,
      sizes: { baseline: [a.width, a.height], current: [b.width, b.height] },
    };
  }

  const { width, height } = a;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, { threshold });
  const total = width * height;
  const ratio = total ? mismatched / total : 0;
  const isDiff = ratio > maxDiffRatio;
  return {
    status: isDiff ? "diff" : "match",
    mismatchedPixels: mismatched,
    totalPixels: total,
    diffRatio: ratio,
    diffPng: isDiff ? PNG.sync.write(diff) : undefined,
  };
}

/** One-line label for reports. */
export function formatVisual(r: VisualResult): string {
  switch (r.status) {
    case "new-baseline":
      return "new baseline captured";
    case "match":
      return "matches baseline";
    case "size-mismatch":
      return `size changed: ${r.sizes?.baseline.join("×")} → ${r.sizes?.current.join("×")}`;
    case "diff":
      return `visual diff: ${r.mismatchedPixels} px (${(r.diffRatio * 100).toFixed(2)}%) changed`;
  }
}
