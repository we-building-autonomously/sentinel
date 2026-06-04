import { describe, it, expect } from "vitest";
import { withRetry } from "./retry.js";
import type { RunReport, Decision } from "./types.js";

function report(decision: Decision): RunReport {
  return {
    spec: { title: "t", task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: { decision, confidence: 1, summary: "s", checkpoints: [], issues: [] },
    startedAt: "", finishedAt: "", durationMs: 1, runDir: "",
  };
}

describe("withRetry", () => {
  it("passes first try: one attempt, not flaky", async () => {
    const out = await withRetry(async () => report("pass"), 2);
    expect(out.attempts).toBe(1);
    expect(out.flaky).toBe(false);
    expect(out.report.verdict.issues).toHaveLength(0);
  });

  it("stops at the first pass", async () => {
    const seq: Decision[] = ["fail", "pass", "pass"];
    let i = 0;
    const out = await withRetry(async () => report(seq[i++]), 5);
    expect(out.attempts).toBe(2);
    expect(i).toBe(2); // didn't run the third
  });

  it("flags flaky when it passes only after a failure", async () => {
    const seq: Decision[] = ["fail", "pass"];
    let i = 0;
    const out = await withRetry(async () => report(seq[i++]), 2);
    expect(out.flaky).toBe(true);
    expect(out.report.flaky).toBe(true);
    expect(out.report.verdict.issues[0]).toMatch(/FLAKY/);
  });

  it("exhausts retries and keeps the failing decision", async () => {
    const out = await withRetry(async () => report("fail"), 2);
    expect(out.attempts).toBe(3);
    expect(out.flaky).toBe(false);
    expect(out.report.verdict.decision).toBe("fail");
    expect(out.report.verdict.issues[0]).toMatch(/Retried 3x/);
  });

  it("retries on inconclusive too", async () => {
    const seq: Decision[] = ["inconclusive", "pass"];
    let i = 0;
    const out = await withRetry(async () => report(seq[i++]), 1);
    expect(out.attempts).toBe(2);
    expect(out.flaky).toBe(true);
  });
});
