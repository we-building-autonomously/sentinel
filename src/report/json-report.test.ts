import { describe, it, expect } from "vitest";
import { toJsonReport, toJsonSuite, JSON_SCHEMA_VERSION } from "./json-report.js";
import { redactReport } from "./redact.js";
import type { RunReport, Decision } from "../types.js";

function fixture(decision: Decision = "pass"): RunReport {
  return {
    spec: {
      title: "Login",
      task: "log in",
      intent: "dashboard",
      app: {
        url: "https://app.example.com",
        auth: { username: "u@e.com", password: "S3CRET", totpSecret: "MYTOTPSEED", extra: { totp: "SEED9" } },
      },
    },
    plan: { goal: "log in", checkpoints: [{ id: 1, description: "dash" }] },
    steps: [
      {
        index: 0,
        thought: "typing password S3CRET",
        call: { name: "type", input: { index: 1, text: "S3CRET" } },
        result: { ok: true, summary: "Typed S3CRET", data: "shows S3CRET" },
        url: "https://app.example.com/login",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ],
    verdict: {
      decision,
      confidence: 0.9,
      summary: "ok",
      checkpoints: [{ id: 1, description: "dash", status: decision === "pass" ? "met" : "unmet", evidence: "saw it" }],
      issues: ["minor"],
    },
    diagnostics: [{ kind: "network", level: "warning", text: "GET /x → 404", status: 404, count: 2 }],
    usage: { byModel: {}, total: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 0, calls: 4 }, costUsd: 0.012 },
    flaky: false,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:05Z",
    durationMs: 5000,
    runDir: "/runs/login",
  };
}

describe("redactReport", () => {
  it("masks password + extra everywhere and never mutates the input", () => {
    const r = fixture();
    const red = redactReport(r);
    const json = JSON.stringify(red);
    expect(json).not.toContain("S3CRET");
    expect(json).not.toContain("SEED9");
    expect(json).not.toContain("MYTOTPSEED"); // TOTP secret masked too
    expect(red.spec.app.auth!.totpSecret).toBe("••••••");
    expect(red.spec.app.auth!.username).toBe("u@e.com"); // non-secret kept
    expect(r.spec.app.auth!.password).toBe("S3CRET"); // original untouched
  });

  it("scrubs secret-shaped tokens from diagnostics/download/request URLs and the triage reason", () => {
    const r = fixture("fail");
    const TOKEN = "cwz_9528d50a09da3f75be1fb07928c1466c0ec3909"; // matches the generic token pattern
    r.diagnostics = [
      {
        kind: "network",
        level: "error",
        text: `GET /api/x?token=${TOKEN} → 500`,
        url: `https://app.example.com/api/x?token=${TOKEN}`,
        status: 500,
        count: 1,
      },
    ];
    r.downloads = [{ filename: "export.csv", url: `https://app.example.com/dl?key=${TOKEN}`, path: "download-0-export.csv", bytes: 10 }];
    r.requestChecks = [{ url: `/api/save?token=${TOKEN}`, observed: 0, met: false }];
    r.triage = { category: "product-defect", reason: `the page revealed ${TOKEN}`, actionable: true };
    // Author-declared assertion values can BE the secret.
    r.textChecks = [{ kind: "absent", text: TOKEN, found: false, met: true }];
    r.urlChecks = [{ kind: "excludes", text: TOKEN, found: false, met: true }];
    r.stateChecks = [{ scope: "localStorage", key: "auth_token", value: TOKEN, absent: false, present: true, met: true }];
    r.downloadChecks = [{ filename: "keys.txt", contentIncludes: TOKEN, met: true }];
    r.clipboardCheck = { expected: TOKEN, met: true };
    // Hook auth headers/body are secrets; hook URLs carry tokens in the query.
    r.spec.setup = [{ method: "POST", url: `https://app.example.com/api/seed?key=${TOKEN}`, headers: { "x-api-key": TOKEN }, body: `{"secret":"${TOKEN}"}` }];
    r.hooks = { setup: [{ method: "POST", url: `https://app.example.com/api/seed?key=${TOKEN}`, status: 200, ok: true }] };

    const json = JSON.stringify(redactReport(r));
    expect(json).not.toContain(TOKEN);
    // The non-secret parts of the URL survive (so the report is still useful).
    expect(json).toContain("/api/x");
    // Original object never mutated.
    expect(r.diagnostics![0].text).toContain(TOKEN);
  });

  it("masks header values, basic-auth password and cookie values", () => {
    const r = fixture();
    r.spec.app.headers = { "x-bypass-token": "BYPASS-XYZ", "x-keep": "ENVTAG" };
    r.spec.app.httpCredentials = { username: "stage", password: "BASIC-PW" };
    r.spec.app.cookies = [{ name: "session", value: "COOKIE-VAL" }];
    const json = JSON.stringify(redactReport(r));
    expect(json).not.toContain("BYPASS-XYZ");
    expect(json).not.toContain("ENVTAG"); // header values masked regardless of name
    expect(json).not.toContain("BASIC-PW");
    expect(json).not.toContain("COOKIE-VAL");
    // names/usernames are not secrets and remain
    expect(json).toContain("x-bypass-token");
    expect(json).toContain("stage");
    // original object untouched
    expect(r.spec.app.cookies![0].value).toBe("COOKIE-VAL");
  });
});

describe("toJsonReport", () => {
  it("produces the stable contract shape with redacted content", () => {
    const doc = toJsonReport(fixture("fail"));
    expect(doc.schemaVersion).toBe(JSON_SCHEMA_VERSION);
    expect(doc).toMatchObject({ title: "Login", decision: "fail", url: "https://app.example.com" });
    expect(JSON.stringify(doc)).not.toContain("S3CRET");
  });

  it("includes triage (null when absent, serialized when present)", () => {
    expect(toJsonReport(fixture()).triage).toBeNull();
    const withTriage = {
      ...fixture("fail"),
      triage: { category: "product-defect" as const, reason: "wrong total", actionable: true },
    };
    expect(toJsonReport(withTriage).triage).toEqual({
      category: "product-defect",
      reason: "wrong total",
      actionable: true,
    });
  });

  it("summarizes checkpoints, diagnostics, usage and steps", () => {
    const doc = toJsonReport(fixture()) as any;
    expect(doc.checkpoints[0]).toMatchObject({ description: "dash", status: "met" });
    expect(doc.diagnostics[0]).toMatchObject({ kind: "network", count: 2 });
    expect(doc.usage).toMatchObject({ costUsd: 0.012, inputTokens: 1000 });
    expect(doc.steps[0]).toMatchObject({ tool: "type", ok: true, index: 0 });
  });
});

describe("toJsonSuite", () => {
  it("aggregates ok flag, summary counts and per-spec results", () => {
    const doc = toJsonSuite([fixture("pass"), fixture("fail")], "Smoke") as any;
    expect(doc.suite).toBe("Smoke");
    expect(doc.ok).toBe(false);
    expect(doc.summary).toMatchObject({ total: 2, pass: 1, fail: 1 });
    expect(doc.results).toHaveLength(2);
    expect(doc.costUsd).toBeCloseTo(0.024, 6);
  });

  it("marks ok=true for an all-pass suite", () => {
    expect((toJsonSuite([fixture("pass")], "S") as any).ok).toBe(true);
  });

  it("exposes the full QA + triage rollup in the suite summary", () => {
    const sec = fixture("pass");
    (sec as any).security = { findings: [{ id: "content-security-policy", severity: "high", message: "x" }], counts: { high: 1, medium: 0, low: 0 } };
    const doc = toJsonSuite([fixture("fail"), sec], "Smoke") as any;
    // Newer QA dimensions + triage breakdown are present for programmatic consumers.
    expect(doc.summary).toHaveProperty("securityIssues", 1);
    expect(doc.summary).toHaveProperty("runtimeErrors");
    expect(doc.summary).toHaveProperty("failedAssertions");
    expect(doc.summary).toHaveProperty("actionable");
    expect(doc.summary.triage).toBeTypeOf("object");
    expect(doc.summary.triage["product-defect"]).toBe(1); // the failing fixture
  });
});
