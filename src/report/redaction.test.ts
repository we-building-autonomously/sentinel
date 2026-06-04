import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeReports } from "./reporter.js";
import type { RunReport } from "../types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-redact-"));

function fixture(): RunReport {
  return {
    spec: {
      title: "Login",
      task: "Log in",
      intent: "Reach dashboard",
      app: {
        url: "https://app.example.com",
        auth: {
          username: "qa@example.com",
          password: "SUPER-SECRET-123",
          extra: { totp: "ABC-TOTP-SEED" },
        },
      },
    },
    plan: { goal: "log in", checkpoints: [{ id: 1, description: "ok" }] },
    steps: [
      {
        index: 0,
        thought: "typing the password SUPER-SECRET-123 now",
        call: { name: "type", input: { index: 1, text: "SUPER-SECRET-123" } },
        result: { ok: true, summary: "Typed SUPER-SECRET-123", data: "page shows SUPER-SECRET-123" },
        url: "https://app.example.com",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ],
    verdict: {
      decision: "pass",
      confidence: 1,
      summary: "ok",
      checkpoints: [{ id: 1, description: "ok", status: "met" }],
      issues: [],
    },
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    runDir: dir,
  };
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("secret redaction", () => {
  it("never writes the password or seeds to any artifact", () => {
    writeReports(fixture());
    for (const f of ["report.json", "report.md", "report.html"]) {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      expect(content, `${f} leaked password`).not.toContain("SUPER-SECRET-123");
      expect(content, `${f} leaked totp`).not.toContain("ABC-TOTP-SEED");
    }
  });

  it("does not mutate the caller's report object", () => {
    const r = fixture();
    writeReports(r);
    // The original object keeps its real secret (redaction works on a clone).
    expect(r.spec.app.auth?.password).toBe("SUPER-SECRET-123");
  });

  it("keeps non-secret content intact", () => {
    writeReports(fixture());
    const json = fs.readFileSync(path.join(dir, "report.json"), "utf8");
    expect(json).toContain("qa@example.com");
    expect(json).toContain("Reach dashboard");
  });
});
