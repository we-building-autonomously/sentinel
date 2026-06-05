import { describe, it, expect } from "vitest";
import { parseGates, qaGateFailures } from "./qa-gate.js";
import type { RunReport } from "./types.js";

function rep(title: string, over: Partial<RunReport> = {}): RunReport {
  return {
    spec: { title, task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: { decision: "pass", confidence: 1, summary: "", checkpoints: [], issues: [] },
    startedAt: "", finishedAt: "", durationMs: 1, runDir: "",
    ...over,
  };
}

const a11y = (crit: number, serious: number, total: number): RunReport["a11y"] => ({
  violations: Array.from({ length: total }, (_, i) => ({ id: `v${i}`, impact: "minor", help: "h", nodes: 1, selectors: [] })),
  counts: { critical: crit, serious, moderate: 0, minor: total - crit - serious },
  total,
});

describe("parseGates", () => {
  it("parses a comma list and drops unknowns", () => {
    expect(parseGates("a11y, visual ,bogus")).toEqual(["a11y", "visual"]);
  });
  it("returns [] for empty/undefined", () => {
    expect(parseGates(undefined)).toEqual([]);
    expect(parseGates("")).toEqual([]);
  });
});

describe("qaGateFailures", () => {
  it("passes (empty) when no gates selected", () => {
    expect(qaGateFailures([rep("a", { a11y: a11y(1, 1, 3) })], [])).toEqual([]);
  });

  it("a11y gate trips on any violation", () => {
    const f = qaGateFailures([rep("a", { a11y: a11y(0, 0, 2) })], ["a11y"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("2 accessibility violation(s)");
  });

  it("a11y-critical trips only on critical/serious, not minor-only", () => {
    expect(qaGateFailures([rep("a", { a11y: a11y(0, 0, 5) })], ["a11y-critical"])).toEqual([]);
    expect(qaGateFailures([rep("a", { a11y: a11y(1, 0, 5) })], ["a11y-critical"])).toHaveLength(1);
  });

  it("perf gate trips on a budget breach", () => {
    const f = qaGateFailures([rep("a", { perfBudgetViolations: [{ metric: "loadMs", actual: 9, budget: 1 }] })], ["perf"]);
    expect(f[0]).toContain("performance budget exceeded");
  });

  it("visual gate trips on a diff or size mismatch", () => {
    const diff = rep("a", { visual: { status: "diff", diffRatio: 0.1, mismatchedPixels: 1, baselinePath: "b" } });
    const size = rep("b", { visual: { status: "size-mismatch", diffRatio: 1, mismatchedPixels: 0, baselinePath: "b" } });
    const ok = rep("c", { visual: { status: "match", diffRatio: 0, mismatchedPixels: 0, baselinePath: "b" } });
    expect(qaGateFailures([diff, size, ok], ["visual"])).toHaveLength(2);
  });

  it("requests gate trips on any unmet request expectation, not on met ones", () => {
    const r = rep("a", {
      requestChecks: [
        { url: "/api/save", method: "POST", observed: 1, met: true },
        { url: "/api/audit", method: "POST", observed: 0, met: false },
        { url: "/api/track", min: 0, observed: 3, met: false },
      ],
    });
    const f = qaGateFailures([r], ["requests"]);
    expect(f).toHaveLength(2); // only the two unmet
    expect(f[0]).toMatch(/unmet request expectation `POST \/api\/audit`/);
    expect(f[1]).toMatch(/must NOT occur/);
  });

  it("requests gate passes when all expectations are met", () => {
    const r = rep("a", { requestChecks: [{ url: "/api/save", observed: 2, met: true }] });
    expect(qaGateFailures([r], ["requests"])).toEqual([]);
  });

  it("parseGates accepts the requests gate", () => {
    expect(parseGates("requests,visual")).toEqual(["requests", "visual"]);
  });

  it("errors gate trips on any error-level diagnostic (not on warnings)", () => {
    const withErr = rep("a", {
      diagnostics: [
        { kind: "pageerror", level: "error", text: "Uncaught TypeError: boom", count: 2 },
        { kind: "network", level: "warning", text: "GET /x → 404", status: 404, count: 1 },
      ],
    });
    const f = qaGateFailures([withErr], ["errors"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/2 runtime error\(s\)/); // counts the x2 occurrences
    expect(f[0]).toMatch(/Uncaught TypeError: boom/);
  });

  it("errors gate passes when only warnings (e.g. a 4xx) were captured", () => {
    const warnOnly = rep("a", {
      diagnostics: [{ kind: "network", level: "warning", text: "GET /x → 404", status: 404, count: 1 }],
    });
    expect(qaGateFailures([warnOnly], ["errors"])).toEqual([]);
  });

  it("parseGates accepts the errors gate", () => {
    expect(parseGates("errors,perf")).toEqual(["errors", "perf"]);
  });

  it("text gate trips on a missing required string OR a present forbidden one", () => {
    const r = rep("a", {
      textChecks: [
        { kind: "present", text: "Order confirmed", found: true, met: true },
        { kind: "present", text: "Receipt #", found: false, met: false },
        { kind: "absent", text: "undefined", found: true, met: false },
      ],
    });
    const f = qaGateFailures([r], ["text"]);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/required text not found — "Receipt #"/);
    expect(f[1]).toMatch(/forbidden text present — "undefined"/);
  });

  it("text gate passes when all assertions are met", () => {
    const r = rep("a", { textChecks: [{ kind: "absent", text: "NaN", found: false, met: true }] });
    expect(qaGateFailures([r], ["text"])).toEqual([]);
  });

  it("url gate trips on a missing required substring OR a present forbidden one", () => {
    const r = rep("a", {
      urlChecks: [
        { kind: "contains", text: "/dashboard", found: true, met: true },
        { kind: "contains", text: "/welcome", found: false, met: false },
        { kind: "excludes", text: "/login", found: true, met: false },
      ],
    });
    const f = qaGateFailures([r], ["url"]);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/final URL missing required substring — "\/welcome"/);
    expect(f[1]).toMatch(/final URL contains forbidden substring — "\/login"/);
  });

  it("parseGates accepts the url gate", () => {
    expect(parseGates("url,text")).toEqual(["url", "text"]);
  });

  it("state gate trips on a missing/wrong/uncleared cookie or storage entry", () => {
    const r = rep("a", {
      stateChecks: [
        { scope: "localStorage", key: "auth_token", absent: false, present: true, met: true },
        { scope: "cookie", key: "cookie_consent", value: "accepted", absent: false, present: false, met: false },
        { scope: "localStorage", key: "flag", absent: false, present: true, met: false },
        { scope: "cookie", key: "session", absent: true, present: true, met: false },
      ],
    });
    const f = qaGateFailures([r], ["state"]);
    expect(f).toHaveLength(3);
    expect(f[0]).toMatch(/cookie "cookie_consent" missing or wrong value \(wanted ~"accepted"\)/);
    expect(f[1]).toMatch(/localStorage "flag" was not set/);
    expect(f[2]).toMatch(/cookie "session" should be cleared but is still present/);
  });

  it("parseGates accepts the state gate", () => {
    expect(parseGates("state")).toEqual(["state"]);
  });

  it("security gate trips on high/medium findings but not low-only", () => {
    const serious = rep("a", {
      security: {
        findings: [
          { id: "content-security-policy", severity: "high", message: "x" },
          { id: "x-frame-options", severity: "medium", message: "x" },
        ],
        counts: { high: 1, medium: 1, low: 0 },
      },
    });
    const lowOnly = rep("b", {
      security: { findings: [{ id: "server", severity: "low", message: "x" }], counts: { high: 0, medium: 0, low: 1 } },
    });
    expect(qaGateFailures([serious], ["security"])).toHaveLength(1);
    expect(qaGateFailures([serious], ["security"])[0]).toMatch(/2 security-header issue/);
    expect(qaGateFailures([lowOnly], ["security"])).toEqual([]); // low is advisory
  });

  it("layout gate trips on horizontal overflow", () => {
    const over = rep("a", { layout: { horizontalOverflow: true, scrollWidth: 800, clientWidth: 390 } });
    const ok = rep("b", { layout: { horizontalOverflow: false, scrollWidth: 390, clientWidth: 390 } });
    expect(qaGateFailures([over], ["layout"])[0]).toMatch(/horizontal overflow.*800px.*390px/);
    expect(qaGateFailures([ok], ["layout"])).toEqual([]);
    expect(parseGates("layout")).toEqual(["layout"]);
  });

  it("downloads gate trips on an unmet download assertion", () => {
    const r = rep("a", {
      downloadChecks: [
        { filename: "report.csv", met: true },
        { filename: "invoice.pdf", contentIncludes: "total", met: false },
      ],
    });
    const f = qaGateFailures([r], ["downloads"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/unmet download assertion "invoice.pdf".*content~"total"/);
    expect(parseGates("downloads")).toEqual(["downloads"]);
  });

  it("clipboard gate trips on an unmet clipboard assertion", () => {
    const miss = rep("a", { clipboardCheck: { expected: "tok_key", met: false } });
    const hit = rep("b", { clipboardCheck: { expected: "tok_key", met: true } });
    expect(qaGateFailures([miss], ["clipboard"])[0]).toMatch(/clipboard did not contain "tok_key"/);
    expect(qaGateFailures([hit], ["clipboard"])).toEqual([]);
    expect(parseGates("clipboard")).toEqual(["clipboard"]);
  });

  it("toast gate trips on an unmet toast/status assertion", () => {
    const miss = rep("a", { toastCheck: { expected: "Saved", met: false } });
    const hit = rep("b", { toastCheck: { expected: "Saved", met: true } });
    expect(qaGateFailures([miss], ["toast"])[0]).toMatch(/no toast\/status message contained "Saved"/);
    expect(qaGateFailures([hit], ["toast"])).toEqual([]);
    expect(parseGates("toast")).toEqual(["toast"]);
  });

  it("combines gates across multiple reports", () => {
    const reports = [
      rep("a", { a11y: a11y(2, 0, 2) }),
      rep("b", { perfBudgetViolations: [{ metric: "fcpMs", actual: 9, budget: 1 }] }),
      rep("c"), // clean
    ];
    expect(qaGateFailures(reports, ["a11y", "perf", "visual"])).toHaveLength(2);
  });
});
