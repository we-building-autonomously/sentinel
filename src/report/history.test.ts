import { describe, it, expect } from "vitest";
import { buildHistory, toHistoryHtml, summarizeRun, computeTrend, countQaIssues, type RunSummary } from "./history.js";
import type { RunReport, Decision } from "../types.js";

function sum(title: string, decision: Decision, startedAt: string, over: Partial<RunSummary> = {}): RunSummary {
  return { title, decision, flaky: false, qaIssues: 0, durationMs: 2000, costUsd: 0.01, startedAt, runDir: "/r", ...over };
}

describe("summarizeRun", () => {
  it("extracts the trended fields from a full report", () => {
    const report = {
      spec: { title: "Login", task: "x", intent: "y", app: { url: "https://e.com" } },
      verdict: { decision: "pass", confidence: 1, summary: "", checkpoints: [], issues: [] },
      flaky: true,
      durationMs: 3000,
      usage: { byModel: {}, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }, costUsd: 0.05 },
      startedAt: "2026-01-01T00:00:00Z",
      runDir: "/runs/login-x",
    } as unknown as RunReport;
    expect(summarizeRun(report)).toMatchObject({ title: "Login", decision: "pass", flaky: true, costUsd: 0.05 });
  });
});

describe("countQaIssues", () => {
  it("is 0 for a clean run", () => {
    expect(countQaIssues({} as RunReport)).toBe(0);
  });
  it("sums issues across every QA dimension", () => {
    const r = {
      a11y: { violations: [{}, {}], counts: {}, total: 2 },
      perfBudgetViolations: [{}],
      visual: { status: "diff" },
      layout: { horizontalOverflow: true },
      security: { counts: { high: 1, medium: 1, low: 5 } },
      diagnostics: [{ level: "error" }, { level: "warning" }],
      requestChecks: [{ met: false }, { met: true }],
      textChecks: [{ met: false }],
      downloadChecks: [{ met: false }],
      clipboardCheck: { met: false },
      toastCheck: { met: false },
    } as unknown as RunReport;
    // 2 a11y + 1 perf + 1 visual + 1 layout + 2 security(high+med) + 1 error
    //   + 1 request + 1 text + 1 download + 1 clipboard + 1 toast = 13 (low security ignored)
    expect(countQaIssues(r)).toBe(13);
  });
});

describe("buildHistory", () => {
  const runs = [
    sum("Login", "pass", "2026-01-01T10:00:00Z"),
    sum("Login", "fail", "2026-01-02T10:00:00Z"),
    sum("Login", "pass", "2026-01-03T10:00:00Z", { flaky: true }),
    sum("Checkout", "fail", "2026-01-01T09:00:00Z"),
  ];

  it("groups by title and computes pass rate", () => {
    const h = buildHistory(runs);
    const login = h.specs.find((s) => s.title === "Login")!;
    expect(login.total).toBe(3);
    expect(login.passes).toBe(2);
    expect(login.passRate).toBeCloseTo(2 / 3, 5);
    expect(login.flakyCount).toBe(1);
  });

  it("uses the most recent run for lastDecision", () => {
    const login = buildHistory(runs).specs.find((s) => s.title === "Login")!;
    expect(login.lastDecision).toBe("pass"); // the 2026-01-03 run
    expect(login.lastRun).toBe("2026-01-03T10:00:00Z");
  });

  it("orders recent newest-first and specs by most-recent activity", () => {
    const h = buildHistory(runs);
    expect(h.specs[0].title).toBe("Login"); // active on Jan 3 vs Checkout Jan 1
    const login = h.specs[0];
    expect(login.recent[0].startedAt).toBe("2026-01-03T10:00:00Z");
    expect(login.recent.at(-1)!.startedAt).toBe("2026-01-01T10:00:00Z");
  });

  it("totals runs, specs and cost", () => {
    const h = buildHistory(runs);
    expect(h.totals).toMatchObject({ runs: 4, specs: 2 });
    expect(h.totals.costUsd).toBeCloseTo(0.04, 6);
  });

  it("handles an empty history", () => {
    const h = buildHistory([]);
    expect(h.specs).toHaveLength(0);
    expect(h.totals.runs).toBe(0);
  });
});

describe("computeTrend", () => {
  const d = (...xs: Decision[]) => xs.map((decision) => ({ decision }));
  it("is 'new' with fewer than two runs", () => {
    expect(computeTrend(d("pass"))).toBe("new");
  });
  it("is 'regressed' when the latest fails after a prior pass", () => {
    expect(computeTrend(d("fail", "pass", "pass"))).toBe("regressed");
    expect(computeTrend(d("inconclusive", "pass"))).toBe("regressed");
  });
  it("is 'fixed' when the latest passes after a prior non-pass", () => {
    expect(computeTrend(d("pass", "fail"))).toBe("fixed");
  });
  it("is 'stable' when unchanged or moving between non-pass states", () => {
    expect(computeTrend(d("pass", "pass", "pass"))).toBe("stable");
    expect(computeTrend(d("fail", "inconclusive"))).toBe("stable");
  });

  it("is triage-aware: an environment block is 'blocked', NOT a regression", () => {
    const block = [
      { decision: "fail" as Decision, category: "blocked-external" as const },
      { decision: "pass" as Decision, category: "passed" as const },
    ];
    expect(computeTrend(block)).toBe("blocked");

    const down = [
      { decision: "inconclusive" as Decision, category: "app-unavailable" as const },
      { decision: "pass" as Decision, category: "passed" as const },
    ];
    expect(computeTrend(down)).toBe("blocked");
  });

  it("still flags a genuine product-defect after a pass as 'regressed'", () => {
    expect(
      computeTrend([
        { decision: "fail", category: "product-defect" },
        { decision: "pass", category: "passed" },
      ])
    ).toBe("regressed");
  });

  it("recovering from an environment block is 'stable', not a spurious 'fixed'", () => {
    expect(
      computeTrend([
        { decision: "pass", category: "passed" },
        { decision: "fail", category: "blocked-external" },
      ])
    ).toBe("stable");
  });
});

describe("buildHistory trend", () => {
  it("tallies regressions, sorts them first, and banners them", () => {
    const runs = [
      // Checkout regressed (fail latest, pass before)
      sum("Checkout", "pass", "2026-06-01T00:00:00Z"),
      sum("Checkout", "fail", "2026-06-02T00:00:00Z"),
      // Login fixed
      sum("Login", "fail", "2026-06-01T00:00:00Z"),
      sum("Login", "pass", "2026-06-03T00:00:00Z"),
    ];
    const h = buildHistory(runs);
    expect(h.totals.regressed).toBe(1);
    expect(h.totals.fixed).toBe(1);
    expect(h.specs[0].title).toBe("Checkout"); // regression sorted to top
    expect(h.specs[0].trend).toBe("regressed");
    const html = toHistoryHtml(h);
    expect(html).toContain("1 spec(s) regressed");
    expect(html).toContain("regressed");
    expect(html).toContain("fixed");
  });
});

describe("buildHistory QA-issue trend", () => {
  it("carries the latest run's QA-issue count and shows it in the dashboard", () => {
    const h = buildHistory([
      sum("Search", "pass", "2026-06-01T00:00:00Z", { qaIssues: 0 }),
      sum("Search", "pass", "2026-06-02T00:00:00Z", { qaIssues: 3 }), // latest
    ]);
    expect(h.specs[0].lastQaIssues).toBe(3);
    expect(toHistoryHtml(h)).toMatch(/⚠ 3/);
  });

  it("flags QA drift when the latest run has MORE issues than the prior, with a banner", () => {
    const h = buildHistory([
      sum("Search", "pass", "2026-06-01T00:00:00Z", { qaIssues: 1 }),
      sum("Search", "pass", "2026-06-02T00:00:00Z", { qaIssues: 4 }), // worse
    ]);
    expect(h.specs[0].qaDrift).toBe(true);
    expect(h.totals.qaDrifted).toBe(1);
    expect(toHistoryHtml(h)).toMatch(/gained QA-dimension issues/);
    expect(toHistoryHtml(h)).toMatch(/⚠ 4 ↑/);
  });

  it("does NOT flag drift when issues stayed the same or improved", () => {
    const same = buildHistory([
      sum("A", "pass", "2026-06-01T00:00:00Z", { qaIssues: 2 }),
      sum("A", "pass", "2026-06-02T00:00:00Z", { qaIssues: 2 }),
    ]);
    expect(same.specs[0].qaDrift).toBe(false);
    const better = buildHistory([
      sum("B", "pass", "2026-06-01T00:00:00Z", { qaIssues: 5 }),
      sum("B", "pass", "2026-06-02T00:00:00Z", { qaIssues: 1 }),
    ]);
    expect(better.specs[0].qaDrift).toBe(false);
    // A single run can't drift.
    expect(buildHistory([sum("C", "pass", "2026-06-01T00:00:00Z", { qaIssues: 3 })]).specs[0].qaDrift).toBe(false);
  });
});

describe("toHistoryHtml", () => {
  it("renders spec titles, pass rate and totals", () => {
    const html = toHistoryHtml(buildHistory([sum("Login", "pass", "2026-01-01T00:00:00Z")]));
    expect(html).toContain("Login");
    expect(html).toContain("100%");
    expect(html).toContain("1</b> specs");
  });

  it("escapes spec titles", () => {
    const html = toHistoryHtml(buildHistory([sum("<b>x</b>", "pass", "2026-01-01T00:00:00Z")]));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("shows an empty-state row when there are no runs", () => {
    expect(toHistoryHtml(buildHistory([]))).toContain("No runs found");
  });
});
