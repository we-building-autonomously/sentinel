import { redactReport } from "./report/redact.js";
import type { RunReport } from "./types.js";

/**
 * The compact, redacted verdict an agent (or the cloud) acts on — distilled
 * from a full RunReport. Shared by the MCP server and the cloud reporter.
 */
export interface QaResult {
  decision: "pass" | "fail" | "inconclusive";
  confidence: number;
  summary: string;
  /** Actionable triage so the agent fails only on genuine product defects. */
  triage?: { category: string; reason: string; actionable: boolean };
  checkpoints: Array<{ description: string; status: "met" | "unmet" | "unknown"; evidence?: string }>;
  /** Things that looked wrong even if the run passed. */
  issues: string[];
  /** Runtime/console/network errors observed during the run. */
  errors: string[];
  /** The user task that was exercised, and the app URL it ran against. */
  task?: string;
  url?: string;
  finalUrl?: string;
  durationMs: number;
  costUsd?: number;
  /** On-disk HTML report a human can open to see screenshots + the full trace. */
  reportDir: string;
}

/** Distil a full RunReport into the compact verdict an agent acts on. */
export function toQaResult(report: RunReport): QaResult {
  const r = redactReport(report);
  return {
    decision: r.verdict.decision,
    confidence: r.verdict.confidence,
    summary: r.verdict.summary,
    triage: r.triage && { category: r.triage.category, reason: r.triage.reason, actionable: r.triage.actionable },
    checkpoints: r.verdict.checkpoints.map((c) => ({
      description: c.description,
      status: c.status ?? "unknown",
      evidence: c.evidence,
    })),
    issues: r.verdict.issues ?? [],
    errors: (r.diagnostics ?? []).filter((d) => d.level === "error").map((d) => `${d.kind}: ${d.text}`),
    task: r.spec?.task,
    url: r.spec?.app?.url,
    finalUrl: r.finalUrl,
    durationMs: r.durationMs,
    costUsd: r.usage?.costUsd,
    reportDir: r.runDir,
  };
}

/** A one-line-per-checkpoint text rendering, for agents that read text not JSON. */
export function summarize(r: QaResult): string {
  const head = `${r.decision.toUpperCase()} (${Math.round(r.confidence * 100)}% confidence) — ${r.summary}`;
  const checks = r.checkpoints
    .map((c) => `  ${c.status === "met" ? "✓" : c.status === "unmet" ? "✗" : "?"} ${c.description}`)
    .join("\n");
  const issues = r.issues.length ? `\nIssues:\n${r.issues.map((i) => `  - ${i}`).join("\n")}` : "";
  const errors = r.errors.length ? `\nRuntime errors:\n${r.errors.map((e) => `  - ${e}`).join("\n")}` : "";
  return `${head}\n${checks}${issues}${errors}\nReport: ${r.reportDir}`;
}
