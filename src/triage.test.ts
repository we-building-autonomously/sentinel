import { describe, it, expect } from "vitest";
import { classifyRun } from "./triage.js";
import type { RunReport, Verdict, Step, Decision } from "./types.js";

function doneStep(outcome: string, notes = ""): Step {
  return {
    index: 0,
    call: { name: "done", input: { outcome, notes } },
    result: { ok: true, summary: "done" },
    url: "http://x",
    timestamp: "t",
  };
}
function actionStep(name = "click"): Step {
  return {
    index: 0,
    call: { name, input: { index: 1 } },
    result: { ok: true, summary: "ok" },
    url: "http://x",
    timestamp: "t",
  };
}
function report(p: {
  decision: Decision;
  summary?: string;
  issues?: string[];
  steps?: Step[];
  flaky?: boolean;
}): RunReport {
  const verdict: Verdict = {
    decision: p.decision,
    confidence: 0.9,
    summary: p.summary ?? "",
    checkpoints: [],
    issues: p.issues ?? [],
  };
  return {
    spec: { title: "t", task: "do it", intent: "done", app: { url: "http://x" } },
    plan: { goal: "g", checkpoints: [] },
    steps: p.steps ?? [],
    verdict,
    flaky: p.flaky,
    startedAt: "a",
    finishedAt: "b",
    durationMs: 1,
    runDir: "/tmp",
  };
}

describe("classifyRun", () => {
  it("clean pass -> passed, not actionable", () => {
    const t = classifyRun(report({ decision: "pass", summary: "all good", steps: [actionStep(), doneStep("success")] }));
    expect(t.category).toBe("passed");
    expect(t.actionable).toBe(false);
  });

  it("pass after a retry -> flaky-pass, actionable", () => {
    const t = classifyRun(report({ decision: "pass", flaky: true, steps: [actionStep()] }));
    expect(t.category).toBe("flaky-pass");
    expect(t.actionable).toBe(true);
  });

  it("fail with the app misbehaving -> product-defect", () => {
    const t = classifyRun(
      report({ decision: "fail", summary: "The total was wrong: showed $0.", steps: [actionStep(), doneStep("failure", "total wrong")] })
    );
    expect(t.category).toBe("product-defect");
    expect(t.reason).toMatch(/total/i);
  });

  it("a detected external challenge routes a fail to blocked-external (not a bug)", () => {
    const t = classifyRun(
      report({
        decision: "fail",
        steps: [actionStep(), doneStep("blocked", "Stopped at a reCAPTCHA on the login page")],
      })
    );
    expect(t.category).toBe("blocked-external");
    expect(t.reason).toMatch(/captcha/i);
  });

  it("challenge keywords in the verdict summary also trigger blocked-external", () => {
    const t = classifyRun(
      report({ decision: "inconclusive", summary: "Could not finish: a two-factor code was required.", steps: [actionStep()] })
    );
    expect(t.category).toBe("blocked-external");
  });

  it("agent blocked without an external gate -> blocked", () => {
    const t = classifyRun(
      report({ decision: "inconclusive", steps: [actionStep(), doneStep("blocked", "The login button never enabled.")] })
    );
    expect(t.category).toBe("blocked");
    expect(t.reason).toMatch(/login button/i);
  });

  it("inconclusive with zero actions -> app-unavailable", () => {
    const t = classifyRun(report({ decision: "inconclusive", summary: "Could not load http://x — unreachable.", steps: [] }));
    expect(t.category).toBe("app-unavailable");
  });

  it("inconclusive after taking actions (ran out of steps) -> inconclusive", () => {
    const t = classifyRun(report({ decision: "inconclusive", summary: "Ran out of steps.", steps: [actionStep(), actionStep()] }));
    expect(t.category).toBe("inconclusive");
  });

  it("everything except a clean pass is actionable", () => {
    const cats = [
      report({ decision: "fail", steps: [actionStep()] }),
      report({ decision: "inconclusive", steps: [] }),
      report({ decision: "pass", flaky: true, steps: [actionStep()] }),
    ];
    for (const r of cats) expect(classifyRun(r).actionable).toBe(true);
  });
});
