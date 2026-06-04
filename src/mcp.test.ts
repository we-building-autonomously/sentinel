import { describe, it, expect } from "vitest";
import { createMcpServer, toQaResult, summarize, type QaResult } from "./mcp.js";
import type { RunReport, RunOptions } from "./runner.js";

function fakeReport(over: Partial<RunReport> = {}): RunReport {
  return {
    spec: { title: "t", task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: {
      decision: "fail",
      confidence: 0.92,
      summary: "never clicked the completion checkbox",
      checkpoints: [
        { id: 1, description: "todo added", status: "met" },
        { id: 2, description: "todo completed", status: "unmet", evidence: "checkbox never clicked" },
      ],
      issues: ["slow first paint"],
    },
    triage: { category: "product-defect", reason: "checkpoint unmet", actionable: true },
    diagnostics: [
      { kind: "pageerror", level: "error", text: "TypeError: x is undefined", count: 1 },
      { kind: "console", level: "warning", text: "deprecated", count: 1 },
    ],
    usage: { byModel: {}, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }, costUsd: 0.03 },
    startedAt: "",
    finishedAt: "",
    durationMs: 4200,
    finalUrl: "https://e.com/app",
    runDir: "/abs/runs/t-123",
    ...over,
  } as RunReport;
}

describe("toQaResult", () => {
  it("distils a RunReport into the compact agent-facing verdict", () => {
    const r = toQaResult(fakeReport());
    expect(r.decision).toBe("fail");
    expect(r.confidence).toBe(0.92);
    expect(r.triage).toEqual({ category: "product-defect", reason: "checkpoint unmet", actionable: true });
    expect(r.checkpoints).toEqual([
      { description: "todo added", status: "met", evidence: undefined },
      { description: "todo completed", status: "unmet", evidence: "checkbox never clicked" },
    ]);
    expect(r.issues).toEqual(["slow first paint"]);
    // only error-level diagnostics surface, mapped to kind: text
    expect(r.errors).toEqual(["pageerror: TypeError: x is undefined"]);
    expect(r.finalUrl).toBe("https://e.com/app");
    expect(r.costUsd).toBe(0.03);
    expect(r.reportDir).toBe("/abs/runs/t-123");
  });

  it("defaults a missing checkpoint status to unknown and tolerates no triage", () => {
    const r = toQaResult(
      fakeReport({
        verdict: { decision: "inconclusive", confidence: 0.4, summary: "blocked", checkpoints: [{ id: 1, description: "cp" }], issues: [] },
        triage: undefined,
        diagnostics: undefined,
      } as Partial<RunReport>),
    );
    expect(r.checkpoints[0].status).toBe("unknown");
    expect(r.triage).toBeUndefined();
    expect(r.errors).toEqual([]);
  });
});

describe("summarize", () => {
  it("renders a verdict head + per-checkpoint ✓/✗/? lines + report path", () => {
    const r: QaResult = toQaResult(fakeReport());
    const text = summarize(r);
    expect(text).toContain("FAIL (92% confidence)");
    expect(text).toContain("✓ todo added");
    expect(text).toContain("✗ todo completed");
    expect(text).toContain("Runtime errors:");
    expect(text).toContain("Report: /abs/runs/t-123");
  });
});

describe("createMcpServer / sentinel_qa tool", () => {
  async function callQa(input: Record<string, unknown>, run: (s: unknown, o: RunOptions) => Promise<RunReport>) {
    const server = createMcpServer({ run });
    // Reach into the registered tool's handler via the server's internal registry.
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools[
      "sentinel_qa"
    ];
    return tool.handler(input, {});
  }

  it("runs an inline spec and returns structured + text content", async () => {
    let receivedSpec: unknown;
    const res = await callQa({ url: "https://e.com", task: "add and complete a todo" }, async (spec) => {
      receivedSpec = spec;
      return fakeReport();
    });
    expect((receivedSpec as { task: string }).task).toBe("add and complete a todo");
    expect(res.structuredContent.decision).toBe("fail");
    expect(res.content[0].text).toContain("FAIL");
    expect(res.isError).toBeFalsy();
  });

  it("returns an error result for an invalid request (no task)", async () => {
    const res = await callQa({ url: "https://e.com" }, async () => fakeReport());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid QA request");
  });

  it("returns an error result when the run throws", async () => {
    const res = await callQa({ url: "https://e.com", task: "do a thing" }, async () => {
      throw new Error("no API key");
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("no API key");
  });
});
