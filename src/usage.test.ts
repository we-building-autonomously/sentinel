import { describe, it, expect } from "vitest";
import { UsageMeter, sumUsage, priceFor, formatUsage, PRICING } from "./usage.js";

describe("priceFor", () => {
  it("maps opus / sonnet / haiku ids (incl. variants) to tiers", () => {
    expect(priceFor("claude-opus-4-8[1m]")).toBe(PRICING["claude-opus-4"]);
    expect(priceFor("claude-sonnet-4-6")).toBe(PRICING["claude-sonnet-4"]);
    expect(priceFor("claude-haiku-4-5-20251001")).toBe(PRICING["claude-haiku-4"]);
  });
  it("defaults unknown models to sonnet pricing", () => {
    expect(priceFor("some-future-model")).toBe(PRICING["claude-sonnet-4"]);
  });
});

describe("UsageMeter", () => {
  it("accumulates per model across calls and counts calls", () => {
    const m = new UsageMeter();
    m.record("claude-sonnet-4-6", { input: 1000, output: 200 });
    m.record("claude-sonnet-4-6", { input: 500, output: 100, cacheRead: 4000 });
    const t = m.totals();
    expect(t.byModel["claude-sonnet-4-6"]).toMatchObject({
      input: 1500,
      output: 300,
      cacheRead: 4000,
      calls: 2,
    });
    expect(t.total.calls).toBe(2);
  });

  it("computes cost from the per-tier price table", () => {
    const m = new UsageMeter();
    // 1M sonnet input + 1M sonnet output = $3 + $15 = $18
    m.record("claude-sonnet-4-6", { input: 1_000_000, output: 1_000_000 });
    expect(m.totals().costUsd).toBeCloseTo(18, 5);
  });

  it("prices opus higher than sonnet for identical usage", () => {
    const o = new UsageMeter();
    o.record("claude-opus-4-8", { input: 1_000_000, output: 1_000_000 });
    const s = new UsageMeter();
    s.record("claude-sonnet-4-6", { input: 1_000_000, output: 1_000_000 });
    expect(o.totals().costUsd).toBeGreaterThan(s.totals().costUsd);
  });

  it("prices cache reads far cheaper than fresh input", () => {
    const cached = new UsageMeter();
    cached.record("claude-sonnet-4-6", { cacheRead: 1_000_000 });
    const fresh = new UsageMeter();
    fresh.record("claude-sonnet-4-6", { input: 1_000_000 });
    expect(cached.totals().costUsd).toBeLessThan(fresh.totals().costUsd);
  });
});

describe("sumUsage", () => {
  it("merges run totals and sums cost, skipping undefined", () => {
    const a = new UsageMeter();
    a.record("claude-sonnet-4-6", { input: 1000, output: 500 });
    const b = new UsageMeter();
    b.record("claude-opus-4-8", { input: 2000, output: 100 });
    const merged = sumUsage([a.totals(), undefined, b.totals()]);
    expect(merged.total.input).toBe(3000);
    expect(Object.keys(merged.byModel)).toHaveLength(2);
    expect(merged.costUsd).toBeCloseTo(a.totals().costUsd + b.totals().costUsd, 9);
  });
});

describe("formatUsage", () => {
  it("renders k-suffixed tokens and a dollar cost", () => {
    const m = new UsageMeter();
    m.record("claude-sonnet-4-6", { input: 12_300, output: 4_100, cacheRead: 8_000 });
    const s = formatUsage(m.totals());
    expect(s).toContain("12.3k in");
    expect(s).toContain("4.1k out");
    expect(s).toContain("8.0k cached");
    expect(s).toMatch(/\$\d/);
  });
});
