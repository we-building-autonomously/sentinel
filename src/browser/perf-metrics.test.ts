import { describe, it, expect } from "vitest";
import { evaluatePerfBudget, formatPerfMetrics, type PerfMetrics } from "./perf-metrics.js";

const metrics: PerfMetrics = {
  ttfbMs: 120,
  fcpMs: 800,
  domContentLoadedMs: 1100,
  loadMs: 2400,
  transferKb: 340,
};

describe("evaluatePerfBudget", () => {
  it("reports nothing when within budget", () => {
    expect(evaluatePerfBudget(metrics, { loadMs: 3000, fcpMs: 1000 })).toEqual([]);
  });

  it("flags each exceeded metric with actual + budget", () => {
    const v = evaluatePerfBudget(metrics, { loadMs: 2000, ttfbMs: 100 });
    expect(v).toEqual([
      { metric: "ttfbMs", actual: 120, budget: 100 },
      { metric: "loadMs", actual: 2400, budget: 2000 },
    ]);
  });

  it("skips metrics that weren't measured (null)", () => {
    const partial: PerfMetrics = { ...metrics, loadMs: null };
    expect(evaluatePerfBudget(partial, { loadMs: 1 })).toEqual([]);
  });

  it("ignores budget keys not set", () => {
    expect(evaluatePerfBudget(metrics, {})).toEqual([]);
  });
});

describe("formatPerfMetrics", () => {
  it("renders the measured metrics", () => {
    expect(formatPerfMetrics(metrics)).toBe("TTFB 120ms · FCP 800ms · load 2400ms · 340KB");
  });
  it("omits null metrics", () => {
    expect(formatPerfMetrics({ ttfbMs: 50, fcpMs: null, domContentLoadedMs: null, loadMs: null, transferKb: null })).toBe(
      "TTFB 50ms"
    );
  });
});
