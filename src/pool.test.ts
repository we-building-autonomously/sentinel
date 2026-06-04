import { describe, it, expect } from "vitest";
import { pool } from "./pool.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pool", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await pool([30, 10, 20, 5], 2, async (ms, i) => {
      await delay(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await pool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
      return 0;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("processes every item exactly once", async () => {
    const seen = new Set<number>();
    await pool(Array.from({ length: 25 }, (_, i) => i), 4, async (x) => {
      seen.add(x);
      return x;
    });
    expect(seen.size).toBe(25);
  });

  it("handles an empty list", async () => {
    expect(await pool([], 4, async () => 1)).toEqual([]);
  });

  it("clamps concurrency to at least 1", async () => {
    const out = await pool([1, 2, 3], 0, async (x) => x * 2);
    expect(out).toEqual([2, 4, 6]);
  });
});
