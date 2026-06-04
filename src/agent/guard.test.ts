import { describe, it, expect } from "vitest";
import { LoopGuard } from "./guard.js";

describe("LoopGuard time budget", () => {
  it("does not stop before the budget elapses", () => {
    const g = new LoopGuard({ startedAt: 1000, maxDurationMs: 5000 });
    expect(g.timeExceeded(3000).stop).toBe(false);
  });

  it("stops once the wall-clock budget is exhausted", () => {
    const g = new LoopGuard({ startedAt: 1000, maxDurationMs: 5000 });
    const v = g.timeExceeded(6000);
    expect(v).toMatchObject({ stop: true, reason: "time" });
  });

  it("never stops on time when no budget is set", () => {
    const g = new LoopGuard({ startedAt: 0 });
    expect(g.timeExceeded(1e12).stop).toBe(false);
  });
});

describe("LoopGuard repeat detection", () => {
  it("stops after the same action repeats maxRepeats times", () => {
    const g = new LoopGuard({ startedAt: 0, maxRepeats: 3 });
    expect(g.register(1, "click:5", "pageA").stop).toBe(false); // 1st
    expect(g.register(2, "click:5", "pageA").stop).toBe(false); // 2nd
    const v = g.register(3, "click:5", "pageA"); // 3rd -> stop
    expect(v).toMatchObject({ stop: true, reason: "repeat" });
  });

  it("resets the repeat counter when the action changes", () => {
    const g = new LoopGuard({ startedAt: 0, maxRepeats: 3 });
    g.register(1, "click:5", "a");
    g.register(2, "click:5", "b");
    g.register(3, "type:6", "c"); // different action resets
    expect(g.register(4, "type:6", "d").stop).toBe(false);
    expect(g.register(5, "type:6", "e").stop).toBe(true); // now 3 in a row
  });
});

describe("LoopGuard no-progress detection", () => {
  it("stops after maxNoProgress steps with an unchanged page", () => {
    const g = new LoopGuard({ startedAt: 0, maxNoProgress: 3, maxRepeats: 99 });
    // distinct actions, but the page signature never changes
    expect(g.register(1, "click:1", "same").stop).toBe(false);
    expect(g.register(2, "click:2", "same").stop).toBe(false);
    const v = g.register(3, "click:3", "same");
    expect(v).toMatchObject({ stop: true, reason: "stuck" });
  });

  it("does not trip when the page keeps changing", () => {
    const g = new LoopGuard({ startedAt: 0, maxNoProgress: 3, maxRepeats: 99 });
    for (let i = 0; i < 10; i++) {
      expect(g.register(i, `click:${i}`, `page${i}`).stop).toBe(false);
    }
  });
});

describe("LoopGuard cycle detection (oscillation)", () => {
  it("stops an A↔B oscillation the repeat/stuck guards miss", () => {
    // High repeat/no-progress caps so ONLY the cycle guard can fire. The page
    // changes every step (no-progress resets) and the action alternates
    // (repeat resets) — yet the agent is going in circles.
    const g = new LoopGuard({ startedAt: 0, maxRepeats: 99, maxNoProgress: 99, maxCycle: 4 });
    for (let i = 0; i < 3; i++) {
      expect(g.register(i * 2, "click:A", "pageA").stop).toBe(false);
      expect(g.register(i * 2 + 1, "click:B", "pageB").stop).toBe(false);
    }
    const v = g.register(99, "click:A", "pageA"); // 4th visit to (pageA, click:A)
    expect(v).toMatchObject({ stop: true, reason: "cycle" });
  });

  it("does NOT flag returning to a page to take DIFFERENT actions", () => {
    const g = new LoopGuard({ startedAt: 0, maxRepeats: 99, maxNoProgress: 99, maxCycle: 4 });
    // Same list page each time, but opening a different item — legitimate.
    for (let i = 0; i < 8; i++) {
      expect(g.register(i, `click:item${i}`, "listPage").stop).toBe(false);
    }
  });

  it("counts non-consecutive recurrences, not just back-to-back", () => {
    const g = new LoopGuard({ startedAt: 0, maxRepeats: 99, maxNoProgress: 99, maxCycle: 3 });
    expect(g.register(1, "click:X", "P").stop).toBe(false); // 1
    expect(g.register(2, "click:Y", "Q").stop).toBe(false);
    expect(g.register(3, "click:X", "P").stop).toBe(false); // 2
    expect(g.register(4, "click:Z", "R").stop).toBe(false);
    expect(g.register(5, "click:X", "P")).toMatchObject({ stop: true, reason: "cycle" }); // 3
  });
});
