import { describe, it, expect } from "vitest";
import { summarize, toSuiteMarkdown, toSuiteHtml, parseVariant, triageRollup, runTriage } from "./suite-report.js";
import type { RunReport, Decision } from "../types.js";

function r(title: string, decision: Decision, ms = 1000): RunReport {
  return {
    spec: { title, task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [{ index: 0, call: { name: "click", input: {} }, result: { ok: true, summary: "" }, url: "", timestamp: "" }],
    verdict: { decision, confidence: 0.8, summary: `did ${title}`, checkpoints: [], issues: [] },
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: ms,
    runDir: `/runs/${title}`,
  };
}

const reports = [r("a", "pass"), r("b", "fail"), r("c", "inconclusive"), r("d", "pass")];

describe("summarize", () => {
  it("tallies decisions and total time", () => {
    const s = summarize(reports);
    expect(s).toMatchObject({ total: 4, pass: 2, fail: 1, inconclusive: 1, durationMs: 4000 });
  });

  it("rolls up a11y violations, perf breaches and visual diffs across runs", () => {
    const a = r("a", "pass");
    a.a11y = { violations: [{ id: "x", impact: "serious", help: "h", nodes: 1 }, { id: "y", impact: "minor", help: "h", nodes: 1 }], counts: { critical: 0, serious: 1, moderate: 0, minor: 1 }, total: 2 };
    const b = r("b", "pass");
    b.perfBudgetViolations = [{ metric: "loadMs", actual: 9000, budget: 5000 }];
    const c = r("c", "fail");
    c.visual = { status: "diff", diffRatio: 0.05, mismatchedPixels: 100, baselinePath: "b.png" };
    const s = summarize([a, b, c]);
    expect(s.a11yViolations).toBe(2);
    expect(s.perfBreaches).toBe(1);
    expect(s.visualDiffs).toBe(1);
  });

  it("rolls up the newer QA dimensions: security, runtime errors, failed assertions", () => {
    const sec = r("sec", "pass");
    sec.security = { findings: [{ id: "content-security-policy", severity: "high", message: "x" }], counts: { high: 1, medium: 0, low: 0 } };
    const lowSec = r("lowsec", "pass"); // low-only -> not counted
    lowSec.security = { findings: [{ id: "server", severity: "low", message: "x" }], counts: { high: 0, medium: 0, low: 1 } };
    const err = r("err", "fail");
    err.diagnostics = [{ kind: "pageerror", level: "error", text: "boom", count: 1 }];
    const asrt = r("asrt", "fail");
    asrt.textChecks = [{ kind: "absent", text: "undefined", found: true, met: false }];
    const lay = r("lay", "fail");
    lay.layout = { horizontalOverflow: true, scrollWidth: 800, clientWidth: 390 };
    const s = summarize([sec, lowSec, err, asrt, lay]);
    expect(s.securityIssues).toBe(1); // only the high-severity one
    expect(s.runtimeErrors).toBe(1);
    expect(s.failedAssertions).toBe(1);
    expect(s.layoutIssues).toBe(1);
    const md = toSuiteMarkdown("S", [sec, err, asrt, lay]);
    expect(md).toMatch(/🔒 1 security/);
    expect(md).toMatch(/💥 1 runtime-error/);
    expect(md).toMatch(/🚩 1 assertion/);
    expect(md).toMatch(/📐 1 layout/);
  });

  it("aggregates a triage breakdown and an actionable count", () => {
    const s = summarize(reports);
    // a/d pass -> passed; b fail -> product-defect; c inconclusive (acted) -> inconclusive.
    expect(s.triage.passed).toBe(2);
    expect(s.triage["product-defect"]).toBe(1);
    expect(s.triage.inconclusive).toBe(1);
    expect(s.actionable).toBe(2); // everything except the two clean passes
  });

  it("respects a pre-computed triage on the report over re-classifying", () => {
    const blocked = { ...r("e", "fail"), triage: { category: "blocked-external" as const, reason: "2FA", actionable: true } };
    const s = summarize([blocked]);
    expect(s.triage["blocked-external"]).toBe(1);
    expect(s.triage["product-defect"]).toBe(0);
    expect(runTriage(blocked).category).toBe("blocked-external");
  });

  it("triageRollup lists non-zero actionable categories, most-urgent first", () => {
    const s = summarize(reports);
    const roll = triageRollup(s);
    expect(roll).toMatch(/product defect/);
    expect(roll).toMatch(/inconclusive/);
    expect(roll).not.toMatch(/passed/); // clean passes are never in the rollup
    expect(roll.indexOf("product defect")).toBeLessThan(roll.indexOf("inconclusive"));
  });

  it("counts a size-mismatch as a visual diff", () => {
    const a = r("a", "pass");
    a.visual = { status: "size-mismatch", diffRatio: 1, mismatchedPixels: 0, baselinePath: "b.png" };
    expect(summarize([a]).visualDiffs).toBe(1);
  });
});

describe("parseVariant", () => {
  it("splits a matrix variant title", () => {
    expect(parseVariant("Checkout [mobile]")).toEqual({ base: "Checkout", variant: "mobile" });
  });
  it("leaves a plain title alone", () => {
    expect(parseVariant("Login works")).toEqual({ base: "Login works" });
  });
});

describe("toSuiteHtml matrix grouping", () => {
  it("clusters variants of the same base and labels them", () => {
    const reports = [r("Login [desktop]", "pass"), r("Checkout [mobile]", "fail"), r("Checkout [desktop]", "pass")];
    const html = toSuiteHtml("S", reports, "/runs");
    // Checkout's two variants appear adjacent (base sorted), with variant labels.
    expect(html.indexOf("Checkout")).toBeLessThan(html.indexOf("Login"));
    expect(html).toContain('class="variant"');
    expect(html).toContain("desktop");
    expect(html).toContain("mobile");
    expect(html).toContain('class="variant-row"');
  });
});

describe("toSuiteMarkdown", () => {
  it("surfaces the triage rollup line and a per-row category for non-passes", () => {
    const md = toSuiteMarkdown("Smoke", reports);
    expect(md).toMatch(/Triage \(2 need attention\):/);
    expect(md).toMatch(/🐛 1 product defect/);
    // The fail row carries a category; a pass row's triage cell is blank.
    const failRow = md.split("\n").find((l) => l.includes("| 🔴 fail |"));
    expect(failRow).toMatch(/product defect/);
  });

  it("headlines the pass ratio and lists every test", () => {
    const md = toSuiteMarkdown("Smoke", reports);
    expect(md).toContain("Smoke — 2/4 passed");
    for (const t of ["a", "b", "c", "d"]) expect(md).toContain(`| ${t} |`);
  });
});

describe("toSuiteHtml", () => {
  it("shows the triage rollup and a per-row category chip", () => {
    const html = toSuiteHtml("Smoke", reports, "/runs");
    expect(html).toContain("need attention");
    expect(html).toContain("product defect");
    expect(html).toContain('<th>Triage</th>');
  });

  it("includes counts and relative links to each report", () => {
    const html = toSuiteHtml("Smoke", reports, "/runs");
    expect(html).toContain("2/4");
    expect(html).toContain('href="a/report.html"');
  });
  it("escapes test titles", () => {
    const html = toSuiteHtml("S", [r("<b>x</b>", "pass")], "/runs");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("shows QA badges and the rollup line when dimensions are present", () => {
    const a = r("Checkout", "pass");
    a.a11y = { violations: [{ id: "x", impact: "serious", help: "h", nodes: 1 }], counts: { critical: 0, serious: 1, moderate: 0, minor: 0 }, total: 1 };
    a.visual = { status: "diff", diffRatio: 0.05, mismatchedPixels: 100, baselinePath: "b.png" };
    const html = toSuiteHtml("S", [a], "/runs");
    expect(html).toContain("QA:");
    expect(html).toContain("1 a11y violation(s)");
    expect(html).toContain("1 visual diff(s)");
    expect(html).toContain('class="qa a11y"');
  });

  it("adds a video link only when the run recorded one", () => {
    const withVideo = r("a", "pass");
    withVideo.runDir = "/runs/a";
    withVideo.videoPath = "page@abc.webm";
    const html = toSuiteHtml("S", [withVideo], "/runs");
    expect(html).toContain('href="a/page@abc.webm"');
    expect(html).toContain(">video</a>");
    // a run without a video has no video link
    expect(toSuiteHtml("S", [r("b", "pass")], "/runs")).not.toContain(">video</a>");
  });
});
