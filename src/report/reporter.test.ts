import { describe, it, expect } from "vitest";
import { toMarkdown, toHtml } from "./reporter.js";
import type { RunReport } from "../types.js";

function fixture(overrides: Partial<RunReport> = {}): RunReport {
  return {
    spec: {
      title: "Login works",
      task: "Log in",
      intent: "User reaches dashboard",
      app: {
        url: "https://app.example.com",
        auth: { username: "qa@example.com", password: "s3cr3t-pw" },
      },
    },
    plan: { goal: "log in", checkpoints: [{ id: 1, description: "Dashboard visible" }] },
    steps: [
      {
        index: 0,
        call: { name: "type", input: { index: 1, text: "s3cr3t-pw" } },
        result: { ok: true, summary: "Typed password s3cr3t-pw into [1]" },
        url: "https://app.example.com/login",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ],
    verdict: {
      decision: "pass",
      confidence: 0.9,
      summary: "Logged in and reached the dashboard.",
      checkpoints: [{ id: 1, description: "Dashboard visible", status: "met", evidence: "saw header" }],
      issues: [],
    },
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:10Z",
    durationMs: 10_000,
    runDir: "/tmp/run",
    ...overrides,
  };
}

describe("report rendering", () => {
  it("markdown shows decision, checkpoints and trace", () => {
    const md = toMarkdown(fixture());
    expect(md).toContain("PASS");
    expect(md).toContain("Dashboard visible");
    expect(md).toContain("`type(");
  });

  it("html escapes and includes the verdict badge", () => {
    const r = fixture();
    r.spec.title = "<script>alert(1)</script>";
    const html = toHtml(r);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("fail decision renders red badge color", () => {
    const r = fixture();
    r.verdict.decision = "fail";
    expect(toHtml(r)).toContain("#dc2626");
  });

  it("renders network-stub activity, flagging stubs that were never hit", () => {
    const r = fixture();
    r.mockActivity = [
      { description: "GET **/api/items → HTTP 500 (JSON)", hits: 3 },
      { description: "**/api/never → HTTP 200 (empty)", hits: 0 },
    ];
    const md = toMarkdown(r);
    expect(md).toContain("Network stubs");
    expect(md).toContain("3 request(s)");
    expect(md).toContain("never hit");
    const html = toHtml(r);
    expect(html).toContain("Network stubs");
    expect(html).toContain("never hit");
  });

  it("renders auto-handled dialogs in markdown and html", () => {
    const r = fixture();
    r.dialogs = [{ type: "confirm", message: "Delete this item?", action: "accepted" }];
    expect(toMarkdown(r)).toContain("Dialogs auto-handled");
    expect(toMarkdown(r)).toContain("Delete this item?");
    const html = toHtml(r);
    expect(html).toContain("Dialogs auto-handled");
    expect(html).toContain("accepted");
  });

  it("renders file downloads in markdown and html, linking saved artifacts", () => {
    const r = fixture();
    r.downloads = [
      { filename: "report.csv", url: "http://x/report.csv", path: "download-0-report.csv", bytes: 128 },
      { filename: "empty.csv", url: "http://x/empty.csv", path: "download-1-empty.csv", bytes: 0 },
    ];
    const md = toMarkdown(r);
    expect(md).toContain("## File downloads");
    expect(md).toContain("[report.csv](download-0-report.csv)");
    expect(md).toContain("128 bytes");
    const html = toHtml(r);
    expect(html).toContain("File downloads");
    expect(html).toContain('href="download-0-report.csv"');
    expect(html).toContain("(empty)"); // 0-byte file flagged
  });

  it("renders network expectations (met/unmet) in markdown", () => {
    const r = fixture();
    r.requestChecks = [
      { url: "/api/save", method: "POST", observed: 1, met: true },
      { url: "/api/track", method: "POST", min: 0, observed: 2, met: false },
    ];
    const md = toMarkdown(r);
    expect(md).toContain("## Network expectations");
    expect(md).toMatch(/✅ `POST \/api\/save` — observed 1/);
    expect(md).toMatch(/❌ `POST \/api\/track .*must NOT occur.*` — observed 2/);
    const html = toHtml(r);
    expect(html).toContain("Network expectations");
    expect(html).toContain("/api/save");
    expect(html).toContain("#dc2626"); // unmet expectation shown in red
  });

  it("renders text assertions (present/absent, met/unmet) in md and html", () => {
    const r = fixture();
    r.textChecks = [
      { kind: "present", text: "Order confirmed", found: true, met: true },
      { kind: "absent", text: "undefined", found: true, met: false },
    ];
    const md = toMarkdown(r);
    expect(md).toContain("## Text assertions");
    expect(md).toMatch(/✅ must contain "Order confirmed"/);
    expect(md).toMatch(/❌ must NOT contain "undefined"/);
    const html = toHtml(r);
    expect(html).toContain("Text assertions");
    expect(html).toContain("#dc2626"); // unmet shown red
  });

  it("renders URL assertions (contains/excludes, met/unmet) in md and html", () => {
    const r = fixture();
    r.urlChecks = [
      { kind: "contains", text: "/dashboard", found: true, met: true },
      { kind: "excludes", text: "/login", found: true, met: false },
    ];
    const md = toMarkdown(r);
    expect(md).toContain("## URL assertions");
    expect(md).toMatch(/✅ final URL must contain "\/dashboard"/);
    expect(md).toMatch(/❌ final URL must NOT contain "\/login"/);
    const html = toHtml(r);
    expect(html).toContain("URL assertions");
    expect(html).toContain("#dc2626"); // unmet shown red
  });

  it("renders state assertions (cookie/storage, present/absent/value) in md and html", () => {
    const r = fixture();
    r.stateChecks = [
      { scope: "cookie", key: "cookie_consent", value: "accepted", absent: false, present: true, met: true },
      { scope: "localStorage", key: "auth_token", absent: false, present: false, met: false },
      { scope: "cookie", key: "session", absent: true, present: true, met: false },
    ];
    const md = toMarkdown(r);
    expect(md).toContain("## State assertions");
    expect(md).toMatch(/✅ cookie "cookie_consent" must contain "accepted"/);
    expect(md).toMatch(/❌ localStorage "auth_token" must be set/);
    expect(md).toMatch(/❌ cookie "session" must be absent/);
    const html = toHtml(r);
    expect(html).toContain("State assertions");
    expect(html).toContain("#dc2626"); // unmet shown red
  });

  it("shows where the run ended (final url + title) in md and html", () => {
    const r = fixture();
    r.finalUrl = "https://app.example.com/dashboard";
    r.finalTitle = "Dashboard — Acme";
    const md = toMarkdown(r);
    expect(md).toMatch(/\*\*Ended at:\*\* https:\/\/app\.example\.com\/dashboard — _Dashboard — Acme_/);
    const html = toHtml(r);
    expect(html).toContain("ended at");
    expect(html).toContain("/dashboard");
    expect(html).toContain("Dashboard — Acme");
  });

  it("does not show a redundant 'Ended at' when the run never navigated", () => {
    const r = fixture();
    r.finalUrl = r.spec.app.url; // same as start
    r.finalTitle = "Login — Acme";
    const md = toMarkdown(r);
    expect(md).not.toContain("**Ended at:**");
    expect(md).toContain("**Final page:** _Login — Acme_");
  });

  it("renders a horizontal-overflow layout warning in md and html", () => {
    const r = fixture();
    r.layout = { horizontalOverflow: true, scrollWidth: 800, clientWidth: 390 };
    const md = toMarkdown(r);
    expect(md).toMatch(/⚠ Layout:.*800px.*390px/);
    const html = toHtml(r);
    expect(html).toContain("horizontal overflow");
    expect(html).toContain("800px");
  });

  it("renders the security-header audit in md and html", () => {
    const r = fixture();
    r.security = {
      findings: [
        { id: "content-security-policy", severity: "high", message: "No CSP header" },
        { id: "referrer-policy", severity: "low", message: "No Referrer-Policy" },
      ],
      counts: { high: 1, medium: 0, low: 1 },
    };
    const md = toMarkdown(r);
    expect(md).toMatch(/## Security headers — 1 high · 0 medium · 1 low/);
    expect(md).toMatch(/\*\*high\*\* `content-security-policy`/);
    const html = toHtml(r);
    expect(html).toContain("Security headers");
    expect(html).toContain("content-security-policy");
    expect(html).toContain("#dc2626"); // high severity dot
  });

  it("renders file uploads and the triage line in html", () => {
    const r = fixture();
    r.uploads = ["1 file: avatar.png"];
    r.triage = { category: "product-defect", reason: "The total was wrong.", actionable: true };
    const html = toHtml(r);
    expect(html).toContain("File uploads");
    expect(html).toContain("avatar.png");
    expect(html).toContain("triage:");
    expect(html).toContain("product-defect");
    expect(html).toContain("The total was wrong.");
  });

  it("renders captured diagnostics in markdown and html", () => {
    const r = fixture();
    r.diagnostics = [
      { kind: "pageerror", level: "error", text: "Uncaught TypeError: boom", count: 2 },
      { kind: "network", level: "warning", text: "GET /api/x → 404", status: 404, count: 1 },
    ];
    const md = toMarkdown(r);
    expect(md).toContain("Console & network errors");
    expect(md).toContain("Uncaught TypeError: boom");
    expect(md).toContain("×2");
    const html = toHtml(r);
    expect(html).toContain("Console &amp; network errors");
    expect(html).toContain("GET /api/x → 404");
  });

  it("omits the diagnostics section when there are none", () => {
    const r = fixture();
    expect(toMarkdown(r)).not.toContain("Console & network errors");
    expect(toHtml(r)).not.toContain("Console &amp; network errors");
  });

  it("renders token usage and cost when present", () => {
    const r = fixture();
    r.usage = {
      byModel: { "claude-sonnet-4-6": { input: 12000, output: 3000, cacheRead: 0, cacheWrite: 0, calls: 5 } },
      total: { input: 12000, output: 3000, cacheRead: 0, cacheWrite: 0, calls: 5 },
      costUsd: 0.081,
    };
    expect(toMarkdown(r)).toContain("$0.0810");
    expect(toHtml(r)).toContain("12.0k in");
  });
});
