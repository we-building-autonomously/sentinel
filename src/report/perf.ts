import type { Step } from "../types.js";

export interface PerfSummary {
  /** Number of timed steps. */
  steps: number;
  /** Sum of all step execution times, in ms. */
  totalActionMs: number;
  /** The slowest step's duration, in ms (0 if none timed). */
  slowestMs: number;
  /** The tool of the slowest step, or null. */
  slowestTool: string | null;
  /** Index of the slowest step, or null. */
  slowestIndex: number | null;
}

/** Summarize per-step timing into a compact perf view for reports. */
export function perfSummary(steps: Step[]): PerfSummary {
  let total = 0;
  let slowestMs = 0;
  let slowestTool: string | null = null;
  let slowestIndex: number | null = null;
  let timed = 0;
  for (const s of steps) {
    if (typeof s.durationMs !== "number") continue;
    timed++;
    total += s.durationMs;
    if (s.durationMs > slowestMs) {
      slowestMs = s.durationMs;
      slowestTool = s.call.name;
      slowestIndex = s.index;
    }
  }
  return { steps: timed, totalActionMs: total, slowestMs, slowestTool, slowestIndex };
}

/** One-line human label, or "" if nothing was timed. */
export function formatPerf(p: PerfSummary): string {
  if (!p.steps) return "";
  const total = (p.totalActionMs / 1000).toFixed(1);
  const slow =
    p.slowestTool != null ? ` · slowest: ${p.slowestTool} ${(p.slowestMs / 1000).toFixed(1)}s` : "";
  return `${total}s in actions${slow}`;
}
