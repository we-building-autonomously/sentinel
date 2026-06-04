import { describe, it, expect } from "vitest";
import { parseTriageCategories, triageGateFailures } from "./triage-gate.js";
import type { RunReport, Decision, Step, Triage } from "./types.js";

function step(name: string, input: Record<string, unknown> = {}): Step {
  return { index: 0, call: { name, input }, result: { ok: true, summary: "" }, url: "", timestamp: "" };
}
function rep(title: string, decision: Decision, opts: { steps?: Step[]; triage?: Triage; flaky?: boolean } = {}): RunReport {
  return {
    spec: { title, task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: opts.steps ?? [step("click")],
    verdict: { decision, confidence: 0.9, summary: `re ${title}`, checkpoints: [], issues: [] },
    triage: opts.triage,
    flaky: opts.flaky,
    startedAt: "", finishedAt: "", durationMs: 1, runDir: "",
  };
}

describe("parseTriageCategories", () => {
  it("parses a comma list of known categories, case-insensitive and deduped", () => {
    expect(parseTriageCategories("product-defect, BLOCKED ,product-defect")).toEqual(["product-defect", "blocked"]);
  });
  it("drops unknown tokens and returns [] for empty/undefined", () => {
    expect(parseTriageCategories("nonsense,product-defect")).toEqual(["product-defect"]);
    expect(parseTriageCategories(undefined)).toEqual([]);
    expect(parseTriageCategories("")).toEqual([]);
  });
  it("expands the 'actionable' alias to every non-passed category", () => {
    const cats = parseTriageCategories("actionable");
    expect(cats).toContain("product-defect");
    expect(cats).toContain("blocked-external");
    expect(cats).not.toContain("passed");
  });
});

describe("triageGateFailures", () => {
  const reports = [
    rep("Checkout", "fail"), // -> product-defect (acted, no block signal)
    rep("Login", "fail", { steps: [step("click"), step("done", { outcome: "blocked", notes: "stuck at reCAPTCHA" })] }), // -> blocked-external
    rep("Home", "pass"), // -> passed
  ];

  it("flags only runs whose triage category is gated", () => {
    const f = triageGateFailures(reports, ["product-defect"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/Checkout: product-defect/);
  });

  it("does NOT flag an external-block when only product-defect is gated (CI stays green on a CAPTCHA)", () => {
    const f = triageGateFailures(reports, ["product-defect"]);
    expect(f.some((m) => /Login/.test(m))).toBe(false);
  });

  it("can gate the environment categories explicitly", () => {
    const f = triageGateFailures(reports, ["blocked-external"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/Login: blocked-external/);
  });

  it("empty category list passes the gate (no failures)", () => {
    expect(triageGateFailures(reports, [])).toEqual([]);
  });

  it("respects a pre-computed triage on the report", () => {
    const r = rep("X", "pass", { triage: { category: "product-defect", reason: "forced", actionable: true } });
    expect(triageGateFailures([r], ["product-defect"])).toHaveLength(1);
  });
});
