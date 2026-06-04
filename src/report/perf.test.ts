import { describe, it, expect } from "vitest";
import { perfSummary, formatPerf } from "./perf.js";
import type { Step } from "../types.js";

function step(index: number, name: string, durationMs?: number): Step {
  return {
    index,
    call: { name, input: {} },
    result: { ok: true, summary: "" },
    url: "",
    timestamp: "",
    durationMs,
  };
}

describe("perfSummary", () => {
  it("totals durations and finds the slowest step", () => {
    const p = perfSummary([step(0, "click", 200), step(1, "type", 5000), step(2, "wait_for", 800)]);
    expect(p.steps).toBe(3);
    expect(p.totalActionMs).toBe(6000);
    expect(p.slowestMs).toBe(5000);
    expect(p.slowestTool).toBe("type");
    expect(p.slowestIndex).toBe(1);
  });

  it("ignores steps without a duration", () => {
    const p = perfSummary([step(0, "click", 100), step(1, "done")]);
    expect(p.steps).toBe(1);
    expect(p.totalActionMs).toBe(100);
  });

  it("handles an empty / untimed trace", () => {
    const p = perfSummary([]);
    expect(p).toMatchObject({ steps: 0, totalActionMs: 0, slowestTool: null, slowestIndex: null });
    expect(formatPerf(p)).toBe("");
  });
});

describe("formatPerf", () => {
  it("renders total action time and the slowest step", () => {
    const s = formatPerf(perfSummary([step(0, "click", 1200), step(1, "navigate", 3400)]));
    expect(s).toContain("4.6s in actions");
    expect(s).toContain("slowest: navigate 3.4s");
  });
});
