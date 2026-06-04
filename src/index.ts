export { runSpec, type RunOptions } from "./runner.js";
export { loadConfig, readConfigFile, configSummary, inspectConfigFile, type SentinelConfig, type ConfigFileStatus } from "./config.js";
export * from "./types.js";
export { writeReports, toMarkdown, toHtml } from "./report/reporter.js";
export { toJUnit } from "./report/junit.js";
export { toTraceViewer } from "./report/trace-viewer.js";
export { toJsonReport, toJsonSuite, JSON_SCHEMA_VERSION } from "./report/json-report.js";
export { perfSummary, formatPerf, type PerfSummary } from "./report/perf.js";
export { redactReport } from "./report/redact.js";
export { scrubSecrets, containsSecret } from "./report/secrets.js";
export {
  buildHistory,
  countQaIssues,
  toHistoryHtml,
  scanRuns,
  summarizeRun,
  writeHistory,
  computeTrend,
  type History,
  type SpecHistory,
  type Trend,
} from "./report/history.js";
export { runSuite, applyDefaults, expandMatrix, SuiteSchema, type Suite } from "./suite.js";
export { pool } from "./pool.js";
export { withRetry, type RetryOutcome } from "./retry.js";
export { LoopGuard, type GuardConfig, type GuardStop } from "./agent/guard.js";
export {
  UsageMeter,
  sumUsage,
  formatUsage,
  priceFor,
  type UsageTotals,
  type ModelUsage,
} from "./usage.js";
export { filterSpecs, type SpecFilter } from "./filter.js";
export { DiagnosticsCollector } from "./browser/diagnostics.js";
export { scaffoldSpec, type ScaffoldedSpec } from "./scaffold.js";
export { buildInlineSpec, defaultIntent, type InlineSpecInput, type InlineSpecResult } from "./inline-spec.js";
export { draftSpecs, draftedSuite, type DraftCase } from "./draft.js";
export { createMcpServer, startMcpServer, type McpOptions } from "./mcp.js";
export { toQaResult, summarize as summarizeQa, type QaResult } from "./qa-result.js";
export { reportRun } from "./cloud.js";
export { profilePage, type PageProfile } from "./browser/profile.js";
export { shouldUseVision, type PageSnapshot } from "./browser/indexer.js";
export { resolveViewport, type ResolvedViewport } from "./browser/viewport.js";
export { fulfillmentFor, methodMatches, describeMock, type NetworkMock } from "./browser/mock.js";
export { pickUploadFiles, describeUpload } from "./browser/upload.js";
export { summarizeAxe, formatA11y, runA11y, type A11yResult, type A11yViolation } from "./browser/a11y.js";
export {
  auditSecurityHeaders,
  auditCookies,
  auditSecurity,
  toAudit,
  formatSecurity,
  type SecurityAudit,
  type SecurityFinding,
  type SecuritySeverity,
  type AuditCookie,
} from "./browser/security.js";
export {
  collectPerfMetrics,
  evaluatePerfBudget,
  formatPerfMetrics,
  type PerfMetrics,
  type PerfBudget,
} from "./browser/perf-metrics.js";
export { compareScreenshots, formatVisual, type VisualResult } from "./browser/visual.js";
export { findApprovals, approveRun, type PendingApproval } from "./approve.js";
export { qaGateFailures, parseGates, type QaGate } from "./qa-gate.js";
export { parseTriageCategories, triageGateFailures, TRIAGE_CATEGORIES } from "./triage-gate.js";
export { findLatestReport, openerFor } from "./open.js";
export { renderTemplate, applyTemplates, makeContext, type TemplateContext } from "./template.js";
export { validateSpecData, type ValidationResult } from "./validate.js";
export { validateConversation } from "./agent/conversation.js";
export { reconcileVerdict } from "./agent/reconcile.js";
export { shouldVisionJudge } from "./agent/judge.js";
export { makePlan, criteriaPlan } from "./agent/planner.js";
export { classifyRun } from "./triage.js";
// RunCategory + Triage types are exported via `export * from "./types.js"`.
export { CallbackLlm, latestObservation, findElementIndex, type Decision } from "./testing/callback-llm.js";
export { looksLoading, type LoadingSignals } from "./browser/loading.js";
export { detectChallenge, challengeNote, type Challenge, type ChallengeKind } from "./browser/challenge.js";
export { detectConsent, consentNote } from "./browser/consent.js";
export { detectAuthFailure, authFailureNote } from "./browser/auth.js";
export { hasHorizontalOverflow, measureLayout, type LayoutMetrics } from "./browser/layout.js";
export { detectErrorState, errorNote, type ErrorState, type ErrorKind } from "./browser/errorpage.js";
export {
  evaluateRequestExpectations,
  requestMatches,
  urlMatches,
  type RequestRecord,
  type RequestExpectation,
  type RequestCheckResult,
} from "./browser/expect-requests.js";
export { evaluateTextExpectations, type TextCheckResult } from "./browser/expect-text.js";
export { evaluateUrlExpectations, type UrlCheckResult } from "./browser/expect-url.js";
export { evaluateStateExpectations, type StateExpectation, type StateCheckResult } from "./browser/expect-state.js";
export { runHook, runHooks, type HttpHook, type HookResult } from "./hooks.js";
export {
  evaluateDownloadExpectations,
  filenameMatches,
  type DownloadInfo,
  type DownloadExpectation,
  type DownloadCheckResult,
} from "./browser/expect-download.js";
export { watchAndRun, fileChangeSource, Debouncer, type ChangeSource } from "./watch.js";
export { runDoctor, summarizeDoctor, doctorExitCode, type Check, type DoctorInput } from "./doctor.js";
export {
  notifySuite,
  notifyRegression,
  buildSuitePayload,
  buildSlackMessage,
  buildRegressionMessage,
  isSlackUrl,
  type SuitePayload,
} from "./notify.js";
export {
  writeSuiteReport,
  summarize,
  hasVisualDiff,
  toSuiteHtml,
  toSuiteMarkdown,
} from "./report/suite-report.js";
