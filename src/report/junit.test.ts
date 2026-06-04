import { describe, it, expect } from "vitest";
import { toJUnit } from "./junit.js";
import type { RunReport, Decision, Step, Triage } from "../types.js";

function action(): Step {
  return { index: 0, call: { name: "click", input: {} }, result: { ok: true, summary: "" }, url: "", timestamp: "" };
}

function report(
  decision: Decision,
  title = "case",
  opts: { steps?: Step[]; triage?: Triage } = {}
): RunReport {
  return {
    spec: { title, task: "t", intent: "i", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: opts.steps ?? [action()],
    verdict: {
      decision,
      confidence: 1,
      summary: `summary for ${decision}`,
      checkpoints: [{ id: 1, description: "cp", status: decision === "pass" ? "met" : "unmet" }],
      issues: decision === "pass" ? [] : ["something odd"],
    },
    triage: opts.triage,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:02Z",
    durationMs: 2000,
    runDir: "/tmp",
  };
}

const blocked = (title: string): RunReport =>
  report("fail", title, { triage: { category: "blocked-external", reason: "hit a CAPTCHA", actionable: true } });

describe("toJUnit (triage-driven outcomes)", () => {
  it("counts tests, failures, errors and skipped by triage category", () => {
    const xml = toJUnit([
      report("pass"), // -> passing
      report("fail"), // product-defect -> failure
      report("inconclusive", "ran-out", { steps: [action(), action()] }), // -> error
      blocked("captcha"), // blocked-external -> skipped
      report("inconclusive", "down", { steps: [] }), // app-unavailable -> skipped
    ]);
    expect(xml).toContain('tests="5"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('skipped="2"');
  });

  it("emits <failure> for a product-defect and <error> for a true inconclusive", () => {
    const xml = toJUnit([
      report("fail", "f"),
      report("inconclusive", "i", { steps: [action(), action()] }),
    ]);
    expect(xml).toMatch(/<testcase[^>]*name="f"[^>]*>[\s\S]*<failure[^>]*type="product-defect"/);
    expect(xml).toMatch(/<testcase[^>]*name="i"[^>]*>[\s\S]*<error[^>]*type="inconclusive"/);
  });

  it("maps an environment block to <skipped> so CI stays neutral, not red", () => {
    const xml = toJUnit([blocked("login")]);
    expect(xml).toMatch(/<testcase[^>]*name="login"[^>]*>[\s\S]*<skipped message="blocked-external: hit a CAPTCHA"/);
    expect(xml).not.toMatch(/name="login"[^>]*>[\s\S]*<failure/);
  });

  it("maps a not-run 'skipped' spec to <skipped>", () => {
    const notRun = report("inconclusive", "budgeted", {
      triage: { category: "skipped", reason: "cost budget reached", actionable: true },
    });
    const xml = toJUnit([notRun]);
    expect(xml).toContain('skipped="1"');
    expect(xml).toMatch(/<testcase[^>]*name="budgeted"[^>]*>[\s\S]*<skipped message="skipped: cost budget reached"/);
  });

  it("includes the triage line in the failure detail body", () => {
    const xml = toJUnit([report("fail", "bug")]);
    expect(xml).toContain("[triage: product-defect]");
  });

  it("passing cases have no failure/skipped body", () => {
    const xml = toJUnit([report("pass", "ok")]);
    expect(xml).toMatch(/<testcase[^>]*name="ok"[^>]*><\/testcase>/);
  });

  it("escapes XML-special characters in titles", () => {
    const xml = toJUnit([report("pass", 'a&b<c>"d"')]);
    expect(xml).toContain("a&amp;b&lt;c&gt;");
    expect(xml).not.toContain('name="a&b');
  });

  it("turns a functionally-PASSING spec into a <failure> when a --fail-on gate breaches", () => {
    const passing = report("pass", "Login", {
      // a high-severity security finding, gated via --fail-on security
    });
    passing.security = { findings: [{ id: "content-security-policy", severity: "high", message: "no CSP" }], counts: { high: 1, medium: 0, low: 0 } };
    const xml = toJUnit([passing], "sentinel", ["security"]);
    expect(xml).toContain('failures="1"');
    expect(xml).toMatch(/<testcase[^>]*name="Login"[^>]*>[\s\S]*<failure[^>]*type="qa-gate"/);
    expect(xml).toMatch(/QA gate breach/);
    expect(xml).toMatch(/content-security-policy/);
  });

  it("does NOT alter outcomes when no gates are passed (default)", () => {
    const passing = report("pass", "Login");
    passing.security = { findings: [{ id: "content-security-policy", severity: "high", message: "x" }], counts: { high: 1, medium: 0, low: 0 } };
    const xml = toJUnit([passing]); // no gates
    expect(xml).toContain('failures="0"');
    expect(xml).toMatch(/<testcase[^>]*name="Login"[^>]*><\/testcase>/);
  });

  it("emits cost/usage/flaky as testsuite properties", () => {
    const r = report("pass");
    r.usage = {
      byModel: {},
      total: { input: 5000, output: 1000, cacheRead: 200, cacheWrite: 0, calls: 3 },
      costUsd: 0.0234,
    };
    r.flaky = true;
    const xml = toJUnit([r]);
    expect(xml).toContain('<property name="cost.usd" value="0.023400"/>');
    expect(xml).toContain('<property name="tokens.input" value="5000"/>');
    expect(xml).toContain('<property name="flaky" value="1"/>');
  });
});
