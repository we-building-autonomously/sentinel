import { describe, it, expect } from "vitest";
import { workflowAnnotations, emitGithub, isGithubActions } from "./github.js";
import type { RunReport, Triage } from "../types.js";

function rep(title: string, decision: RunReport["verdict"]["decision"], triage?: Triage, summary = ""): RunReport {
  return {
    spec: { title, task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: { decision, confidence: 1, summary, checkpoints: [], issues: [] },
    triage,
    startedAt: "", finishedAt: "", durationMs: 1200, runDir: "",
  } as RunReport;
}

describe("workflowAnnotations", () => {
  it("maps triage categories to the right workflow-command level", () => {
    const reports = [
      rep("Bug", "fail", { category: "product-defect", reason: "Total shows NaN", actionable: true }),
      rep("Captcha", "fail", { category: "blocked-external", reason: "CAPTCHA wall", actionable: true }),
      rep("Flaky", "pass", { category: "flaky-pass", reason: "Passed on retry", actionable: true }),
      rep("Good", "pass", { category: "passed", reason: "ok", actionable: false }),
    ];
    const a = workflowAnnotations(reports);
    expect(a).toHaveLength(3); // passed emits nothing
    expect(a[0]).toBe("::error title=Sentinel%3A Bug::Total shows NaN");
    expect(a[1]).toMatch(/^::warning title=Sentinel%3A Captcha::CAPTCHA wall$/);
    expect(a[2]).toMatch(/^::notice /);
  });

  it("escapes commas/colons in the title and collapses a multi-line message to one line", () => {
    const a = workflowAnnotations([
      rep("A: b, c", "fail", { category: "product-defect", reason: "line1\nline2", actionable: true }),
    ]);
    expect(a[0]).toContain("title=Sentinel%3A A%3A b%2C c");
    // Annotation messages are single-line: whitespace (incl. newlines) is collapsed.
    expect(a[0]).toMatch(/::line1 line2$/);
  });

  it("falls back to the verdict summary when no triage reason", () => {
    const a = workflowAnnotations([rep("X", "fail", { category: "product-defect", reason: "", actionable: true }, "boom happened")]);
    expect(a[0]).toBe("::error title=Sentinel%3A X::boom happened");
  });
});

describe("isGithubActions", () => {
  it("is true only when GITHUB_ACTIONS=true", () => {
    expect(isGithubActions({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isGithubActions({ GITHUB_ACTIONS: "false" })).toBe(false);
    expect(isGithubActions({})).toBe(false);
  });
});

describe("emitGithub", () => {
  const reports = [
    rep("Good", "pass", { category: "passed", reason: "ok", actionable: false }),
    rep("Bug", "fail", { category: "product-defect", reason: "broken", actionable: true }),
  ];

  it("writes the job summary to $GITHUB_STEP_SUMMARY and logs annotations", () => {
    const writes: Array<[string, string]> = [];
    const logs: string[] = [];
    const res = emitGithub({
      reports,
      suiteName: "CI suite",
      env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: "/tmp/summary.md" },
      appendFile: (p, d) => writes.push([p, d]),
      log: (l) => logs.push(l),
    });
    expect(res).toEqual({ summaryWritten: true, annotations: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/tmp/summary.md");
    expect(writes[0][1]).toContain("CI suite — 1/2 passed"); // toSuiteMarkdown header
    expect(logs).toEqual(["::error title=Sentinel%3A Bug::broken"]);
  });

  it("still emits annotations when no summary path is set", () => {
    const logs: string[] = [];
    const res = emitGithub({ reports, suiteName: "s", env: { GITHUB_ACTIONS: "true" }, appendFile: () => {}, log: (l) => logs.push(l) });
    expect(res.summaryWritten).toBe(false);
    expect(res.annotations).toBe(1);
    expect(logs).toHaveLength(1);
  });

  it("swallows a summary write failure (reporting is best-effort)", () => {
    const res = emitGithub({
      reports,
      suiteName: "s",
      env: { GITHUB_STEP_SUMMARY: "/tmp/x.md" },
      appendFile: () => {
        throw new Error("disk full");
      },
      log: () => {},
    });
    expect(res.summaryWritten).toBe(false);
    expect(res.annotations).toBe(1);
  });
});
