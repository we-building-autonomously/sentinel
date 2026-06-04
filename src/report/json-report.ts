import type { RunReport } from "../types.js";
import { redactReport } from "./redact.js";
import { summarize } from "./suite-report.js";
import { sumUsage } from "../usage.js";
import { perfSummary } from "./perf.js";

/** Bump when the JSON contract changes in a breaking way. */
export const JSON_SCHEMA_VERSION = 16;

/**
 * A stable, redacted, machine-readable view of a single run — the contract for
 * `--json` consumers and programmatic integrations. Intentionally flatter and
 * more stable than the full RunReport.
 */
export function toJsonReport(reportRaw: RunReport): Record<string, unknown> {
  const r = redactReport(reportRaw);
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    title: r.spec.title,
    url: r.spec.app.url,
    finalUrl: r.finalUrl ?? null,
    finalTitle: r.finalTitle ?? null,
    decision: r.verdict.decision,
    confidence: r.verdict.confidence,
    summary: r.verdict.summary,
    triage: r.triage
      ? { category: r.triage.category, reason: r.triage.reason, actionable: r.triage.actionable }
      : null,
    flaky: !!r.flaky,
    attempts: r.attempts ?? 1,
    durationMs: r.durationMs,
    perf: perfSummary(r.steps),
    videoPath: r.videoPath ?? null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    checkpoints: r.verdict.checkpoints.map((c) => ({
      description: c.description,
      status: c.status ?? "unknown",
      evidence: c.evidence ?? null,
    })),
    issues: r.verdict.issues,
    diagnostics: (r.diagnostics ?? []).map((d) => ({
      kind: d.kind,
      level: d.level,
      text: d.text,
      count: d.count,
    })),
    dialogs: (r.dialogs ?? []).map((d) => ({ type: d.type, message: d.message, action: d.action })),
    liveAnnouncements: r.liveAnnouncements ?? [],
    downloads: (r.downloads ?? []).map((d) => ({
      filename: d.filename,
      url: d.url,
      path: d.path ?? null,
      bytes: d.bytes ?? null,
      error: d.error ?? null,
    })),
    uploads: r.uploads ?? [],
    requestChecks: (r.requestChecks ?? []).map((c) => ({
      url: c.url,
      method: c.method ?? null,
      status: c.status ?? null,
      bodyIncludes: c.bodyIncludes ?? null,
      min: c.min ?? null,
      observed: c.observed,
      met: c.met,
    })),
    textChecks: (r.textChecks ?? []).map((c) => ({ kind: c.kind, text: c.text, found: c.found, met: c.met })),
    urlChecks: (r.urlChecks ?? []).map((c) => ({ kind: c.kind, text: c.text, found: c.found, met: c.met })),
    stateChecks: (r.stateChecks ?? []).map((c) => ({ scope: c.scope, key: c.key, value: c.value ?? null, absent: c.absent, present: c.present, met: c.met })),
    downloadChecks: (r.downloadChecks ?? []).map((c) => ({ filename: c.filename ?? null, contentIncludes: c.contentIncludes ?? null, met: c.met })),
    clipboardCheck: r.clipboardCheck ?? null,
    toastCheck: r.toastCheck ?? null,
    hooks: r.hooks
      ? {
          setup: (r.hooks.setup ?? []).map((h) => ({ method: h.method, url: h.url, status: h.status ?? null, ok: h.ok, error: h.error ?? null })),
          teardown: (r.hooks.teardown ?? []).map((h) => ({ method: h.method, url: h.url, status: h.status ?? null, ok: h.ok, error: h.error ?? null })),
        }
      : null,
    mocks: (r.mockActivity ?? []).map((m) => ({ description: m.description, hits: m.hits })),
    a11y: r.a11y ? { counts: r.a11y.counts, total: r.a11y.total, violations: r.a11y.violations } : null,
    security: r.security ? { counts: r.security.counts, findings: r.security.findings } : null,
    layout: r.layout ?? null,
    perfMetrics: r.perfMetrics ?? null,
    perfBudgetViolations: r.perfBudgetViolations ?? [],
    visual: r.visual ?? null,
    usage: r.usage
      ? {
          costUsd: r.usage.costUsd,
          inputTokens: r.usage.total.input,
          outputTokens: r.usage.total.output,
          cacheReadTokens: r.usage.total.cacheRead,
        }
      : null,
    steps: r.steps.map((s) => ({
      index: s.index,
      tool: s.call.name,
      args: s.call.input,
      ok: s.result.ok,
      summary: s.result.summary,
      url: s.url,
      durationMs: s.durationMs ?? null,
    })),
    runDir: r.runDir,
  };
}

/** A stable, machine-readable view of a whole suite run. */
export function toJsonSuite(reports: RunReport[], suiteName: string): Record<string, unknown> {
  const s = summarize(reports);
  const usage = sumUsage(reports.map((r) => r.usage));
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    suite: suiteName,
    ok: s.fail === 0 && s.inconclusive === 0,
    summary: {
      total: s.total,
      pass: s.pass,
      fail: s.fail,
      inconclusive: s.inconclusive,
      flaky: s.flaky,
      // Actionable triage rollup (everything but a clean pass) + per-category breakdown.
      actionable: s.actionable,
      triage: s.triage,
      // QA dimensions.
      a11yViolations: s.a11yViolations,
      perfBreaches: s.perfBreaches,
      visualDiffs: s.visualDiffs,
      layoutIssues: s.layoutIssues,
      securityIssues: s.securityIssues,
      runtimeErrors: s.runtimeErrors,
      failedAssertions: s.failedAssertions,
    },
    costUsd: usage.costUsd,
    durationMs: s.durationMs,
    results: reports.map((r) => toJsonReport(r)),
  };
}
