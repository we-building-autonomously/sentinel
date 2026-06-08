/**
 * Core domain types for Sentinel — the browser-native testing harness.
 *
 * The data flow is:
 *   TestSpec  ->  Plan (checkpoints)  ->  AgentRun (steps)  ->  Verdict  ->  Report
 */

import { z } from "zod";
import type { UsageTotals } from "./usage.js";

/* ------------------------------------------------------------------ *
 * Input: the test specification
 * ------------------------------------------------------------------ */

/** A setup/teardown HTTP request fired around the browser run (state isolation). */
export const HttpHookSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  /** Required status; default = any 2xx. */
  expectStatus: z.number().int().optional(),
});

/** Credentials / setup needed to reach the part of the app under test. */
export const AppAuthSchema = z.object({
  /** A human description of how to log in, if non-obvious. */
  strategy: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  /** Base32 TOTP secret for a 2FA-protected login; the agent fetches the
   * current code on demand via the `get_totp` tool. */
  totpSecret: z.string().optional(),
  /** Arbitrary extra fields (api keys, otp seeds, etc.) surfaced to the agent. */
  extra: z.record(z.string()).optional(),
});
export type AppAuth = z.infer<typeof AppAuthSchema>;

export const AppMetaSchema = z.object({
  /** The base URL the test starts from. */
  url: z.string().url(),
  /** Optional friendly name of the app. */
  name: z.string().optional(),
  /** Optional auth/login info. Secrets are redacted from logs & reports. */
  auth: AppAuthSchema.optional(),
  /** Free-form notes about the app the agent should know (quirks, data, etc.). */
  notes: z.string().optional(),
  /** Extra HTTP headers on every request (e.g. a staging bypass token). Redacted. */
  headers: z.record(z.string()).optional(),
  /** HTTP basic-auth credentials for protected staging environments. Redacted. */
  httpCredentials: z.object({ username: z.string(), password: z.string() }).optional(),
  /** Cookies to seed before the run (e.g. a session or feature-flag cookie). Values redacted. */
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string().optional(),
        path: z.string().optional(),
        url: z.string().optional(),
      })
    )
    .optional(),
});
export type AppMeta = z.infer<typeof AppMetaSchema>;

export const TestSpecSchema = z.object({
  /** Stable id for the test (slug). Generated if omitted. */
  id: z.string().optional(),
  /** Short title. */
  title: z.string(),
  /** What the agent should *do* — the task, phrased like a user story. */
  task: z.string(),
  /** What success looks like — the acceptance criteria / user intent. */
  intent: z.string(),
  /** The app under test. */
  app: AppMetaSchema,
  /**
   * Optional explicit acceptance criteria. When provided they ARE the
   * checkpoints — used verbatim, one-to-one, in order (a contract the planner
   * must not reword or drop). When omitted, checkpoints are derived from intent.
   */
  criteria: z.array(z.string()).optional(),
  /** Hard cap on agent steps for this spec. */
  maxSteps: z.number().int().positive().optional(),
  /** Labels for filtering a suite (e.g. "smoke", "auth", "critical"). */
  tags: z.array(z.string()).optional(),
  /**
   * Viewport / device to test at: a preset ("desktop" | "tablet" | "mobile"),
   * a Playwright device name ("iPhone 13"), or explicit { width, height }.
   */
  viewport: z
    .union([z.string(), z.object({ width: z.number().int().positive(), height: z.number().int().positive() })])
    .optional(),
  /**
   * Browser emulation for theme / i18n / a11y tests: dark mode, reduced motion,
   * locale (affects Intl number/date/currency formatting and `navigator.language`),
   * and timezone (affects displayed dates/times).
   */
  emulate: z
    .object({
      colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
      reducedMotion: z.enum(["reduce", "no-preference"]).optional(),
      locale: z.string().optional(),
      timezoneId: z.string().optional(),
    })
    .optional(),
  /**
   * Freeze the browser clock for deterministic date/time testing. `now` is an
   * ISO-8601 string ("2026-01-15T09:00:00Z") or epoch ms — every `new Date()` /
   * `Date.now()` in the app returns it, so "today's date", relative timestamps,
   * countdowns and trial-expiry banners are reproducible.
   */
  clock: z.object({ now: z.union([z.string(), z.number()]) }).optional(),
  /** File paths offered to native file pickers when the flow uploads a file. */
  uploads: z.array(z.string()).optional(),
  /** Run an axe-core accessibility audit on the final page and report violations. */
  a11y: z.boolean().optional(),
  /** Audit the main document's security response headers (CSP, HSTS, etc.). */
  security: z.boolean().optional(),
  /** Visual regression: compare the final page to a saved baseline screenshot. */
  visual: z.union([z.boolean(), z.object({ maxDiffRatio: z.number().min(0).max(1).optional() })]).optional(),
  /** Fail-worthy page-load budget (ms). Violations are reported and judged. */
  perfBudget: z
    .object({
      ttfbMs: z.number().int().positive().optional(),
      fcpMs: z.number().int().positive().optional(),
      loadMs: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Assert the app made (or didn't make) certain HTTP requests during the run.
   * Catches optimistic-UI bugs where the screen shows success but no request
   * fired. `url` is a glob (with `*`) or substring; `min: 0` asserts absence.
   */
  expectRequests: z
    .array(
      z.object({
        url: z.string(),
        method: z.string().optional(),
        status: z.number().int().optional(),
        bodyIncludes: z.string().optional(),
        min: z.number().int().nonnegative().optional(),
      })
    )
    .optional(),
  /** Text that MUST appear on the final page (case-sensitive substring). */
  expectText: z.array(z.string()).optional(),
  /**
   * Text that must NOT appear on the final page — catches unrendered template
   * vars, "undefined"/"NaN"/"[object Object]", leaked error strings, etc.
   */
  forbidText: z.array(z.string()).optional(),
  /** Substrings the FINAL page URL must contain (e.g. "/dashboard") — verifies redirects. */
  expectUrl: z.array(z.string()).optional(),
  /** Substrings the final page URL must NOT contain (e.g. "/login", "error="). */
  forbidUrl: z.array(z.string()).optional(),
  /**
   * Data-driven cases: run this spec once per row, each row's fields exposed as
   * `{{tokens}}` (e.g. `{{card}}`) and `name` used for the `[case]` title suffix.
   * Expanded before the run; not seen by a single run's executor directly.
   */
  cases: z.array(z.record(z.string())).optional(),
  /**
   * HTTP requests fired BEFORE the browser run (state isolation: seed/reset data
   * via an API). A failed setup hook blocks the run. URLs/bodies are templated.
   */
  setup: z.array(HttpHookSchema).optional(),
  /** HTTP requests fired AFTER the run (best-effort cleanup; failures only noted). */
  teardown: z.array(HttpHookSchema).optional(),
  /**
   * Persisted-state assertions on cookies / local / session storage after the
   * run — e.g. consent set a cookie, login stored a token, logout cleared it.
   */
  expectState: z
    .array(
      z.object({
        scope: z.enum(["cookie", "localStorage", "sessionStorage"]),
        key: z.string(),
        value: z.string().optional(),
        absent: z.boolean().optional(),
      })
    )
    .optional(),
  /**
   * Assert the app downloaded a file: each entry has a `filename` (glob/substring)
   * and/or a `contentIncludes` substring its text must contain. Verifies exports.
   */
  expectDownloads: z
    .array(z.object({ filename: z.string().optional(), contentIncludes: z.string().optional() }))
    .optional(),
  /** Assert the app copied this substring to the clipboard (a copy-to-clipboard button). */
  expectClipboard: z.string().optional(),
  /** Assert a toast/status message containing this substring was announced (even if it vanished). */
  expectToast: z.string().optional(),
  /** Network stubs to test hard-to-reach states (errors, empty, slow). */
  mocks: z
    .array(
      z.object({
        url: z.string(),
        method: z.string().optional(),
        status: z.number().int().optional(),
        json: z.unknown().optional(),
        body: z.string().optional(),
        contentType: z.string().optional(),
        delayMs: z.number().int().nonnegative().optional(),
      })
    )
    .optional(),
});
export type TestSpec = z.infer<typeof TestSpecSchema>;

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

export interface Checkpoint {
  id: number;
  /** A single, observable acceptance criterion. */
  description: string;
  /** Filled in by the judge at the end. */
  status?: "met" | "unmet" | "unknown";
  evidence?: string;
  /**
   * Index of the step whose screenshot/trace entry most directly proves this
   * checkpoint — the moment it should hold. Lets the report show the proving
   * frame and stops end-state from contaminating an early checkpoint. Undefined
   * (or -1) when no single step proves it (e.g. the initial page load).
   */
  proofStep?: number;
  /**
   * How directly the evidence supports the status: "strong" = seen on a
   * screenshot or a deterministic assertion; "weak" = inferred indirectly;
   * "none" = not actually observable. A "met" with "none" can't be trusted and
   * is reconciled down. Spot-check anything below "strong".
   */
  evidenceStrength?: "strong" | "weak" | "none";
}

export interface Plan {
  /** Restatement of the goal in the agent's own words. */
  goal: string;
  /** Ordered, observable checkpoints that together prove success. */
  checkpoints: Checkpoint[];
}

/* ------------------------------------------------------------------ *
 * The agent run: steps and observations
 * ------------------------------------------------------------------ */

/** A single tool call the agent decided to make. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** The result of executing a tool. */
export interface ToolResult {
  ok: boolean;
  /** Short textual summary fed back to the model. */
  summary: string;
  /** Optional structured data (e.g. extracted text). */
  data?: unknown;
  /** Path to a screenshot captured after the action, relative to the run dir. */
  screenshot?: string;
  /** Viewport bounding box of the element acted on, for highlighting in the trace. */
  target?: { x: number; y: number; w: number; h: number };
}

export interface Step {
  index: number;
  /** Model's reasoning for this step (its "thought"). */
  thought?: string;
  call: ToolCall;
  result: ToolResult;
  /** URL after the step executed. */
  url: string;
  timestamp: string;
  /** Wall-clock time the tool execution took, in ms. */
  durationMs?: number;
}

/* ------------------------------------------------------------------ *
 * Output: the verdict
 * ------------------------------------------------------------------ */

export type Decision = "pass" | "fail" | "inconclusive";

export interface Verdict {
  decision: Decision;
  /** 0..1 confidence in the decision. */
  confidence: number;
  /** One-paragraph human summary, like a QA engineer's note. */
  summary: string;
  /** Per-checkpoint resolution. */
  checkpoints: Checkpoint[];
  /** Things that went wrong or looked suspicious even if the test passed. */
  issues: string[];
}

/** A runtime health signal captured from the page during the run. */
export interface Diagnostic {
  kind: "pageerror" | "console" | "network";
  level: "error" | "warning";
  text: string;
  url?: string;
  status?: number;
  count: number;
}

/** A JS dialog (alert/confirm/prompt/beforeunload) that Sentinel auto-handled. */
export interface DialogRecord {
  type: string;
  message: string;
  action: "accepted" | "dismissed";
}

/** A file the app triggered a download of during the run (e.g. an export). */
export interface DownloadRecord {
  /** The browser-suggested filename (e.g. "report.csv"). */
  filename: string;
  /** The download URL. */
  url: string;
  /** Saved artifact path relative to the run dir, when the save succeeded. */
  path?: string;
  /** File size in bytes, when known. */
  bytes?: number;
  /** Populated when the download could not be saved. */
  error?: string;
}

/** An actionable bucket for triaging a run at suite scale. */
export type RunCategory =
  | "passed"
  | "flaky-pass"
  | "product-defect"
  | "blocked-external"
  | "blocked"
  | "app-unavailable"
  | "inconclusive"
  /** The spec was not run (shared login failed, cost budget reached). */
  | "skipped";

export interface Triage {
  category: RunCategory;
  /** One-line, human-facing reason — drawn from real run signals. */
  reason: string;
  /** True if this outcome needs a human to look (everything except a clean pass). */
  actionable: boolean;
}

export interface RunReport {
  spec: TestSpec;
  plan: Plan;
  steps: Step[];
  verdict: Verdict;
  /** Actionable outcome classification derived from the verdict + run signals. */
  triage?: Triage;
  /** Results of setup/teardown HTTP hooks (state isolation), when declared. */
  hooks?: {
    setup?: Array<{ method: string; url: string; status?: number; ok: boolean; error?: string }>;
    teardown?: Array<{ method: string; url: string; status?: number; ok: boolean; error?: string }>;
  };
  /** Console/network/runtime errors observed during the run. */
  diagnostics?: Diagnostic[];
  /** JS dialogs that appeared and were auto-handled. */
  dialogs?: DialogRecord[];
  /** Files the app triggered downloads of (exports, generated reports, etc.). */
  downloads?: DownloadRecord[];
  /** Files fed to native file pickers during the run. */
  uploads?: string[];
  /** Declared network stubs and how many requests each served (0 = never hit). */
  mockActivity?: Array<{ description: string; hits: number }>;
  /** Results of declared network-request expectations (see spec.expectRequests). */
  requestChecks?: Array<{
    url: string;
    method?: string;
    status?: number;
    bodyIncludes?: string;
    min?: number;
    observed: number;
    met: boolean;
  }>;
  /** Results of declared text content assertions (see spec.expectText/forbidText). */
  textChecks?: Array<{ kind: "present" | "absent"; text: string; found: boolean; met: boolean }>;
  /** Results of declared URL assertions (see spec.expectUrl/forbidUrl). */
  urlChecks?: Array<{ kind: "contains" | "excludes"; text: string; found: boolean; met: boolean }>;
  /** Results of declared persisted-state assertions (see spec.expectState). */
  stateChecks?: Array<{
    scope: "cookie" | "localStorage" | "sessionStorage";
    key: string;
    value?: string;
    absent: boolean;
    present: boolean;
    met: boolean;
  }>;
  /** Results of declared download assertions (see spec.expectDownloads). */
  downloadChecks?: Array<{ filename?: string; contentIncludes?: string; met: boolean }>;
  /** Result of a clipboard assertion (see spec.expectClipboard). */
  clipboardCheck?: { expected: string; met: boolean };
  /** Result of a toast/status assertion (see spec.expectToast). */
  toastCheck?: { expected: string; met: boolean };
  /** ARIA live-region announcements (toasts/status messages) captured during the run. */
  liveAnnouncements?: string[];
  /** Accessibility audit (axe-core) of the final page, if `a11y` was enabled. */
  a11y?: {
    violations: Array<{ id: string; impact: string; help: string; nodes: number; selectors: string[] }>;
    counts: { critical: number; serious: number; moderate: number; minor: number };
    total: number;
  };
  /** Responsive-layout signal: the final page overflows the viewport horizontally. */
  layout?: { horizontalOverflow: boolean; scrollWidth: number; clientWidth: number };
  /** Security-header audit of the main document (when `security` is enabled). */
  security?: {
    findings: Array<{ id: string; severity: "high" | "medium" | "low"; message: string }>;
    counts: { high: number; medium: number; low: number };
  };
  /** Page-load performance metrics of the initial load. */
  perfMetrics?: {
    ttfbMs: number | null;
    fcpMs: number | null;
    domContentLoadedMs: number | null;
    loadMs: number | null;
    transferKb: number | null;
  };
  /** Perf-budget violations (when a `perfBudget` was set). */
  perfBudgetViolations?: Array<{ metric: string; actual: number; budget: number }>;
  /** Visual-regression result vs the baseline (when `visual` was enabled). */
  visual?: {
    status: "match" | "diff" | "size-mismatch" | "new-baseline";
    diffRatio: number;
    mismatchedPixels: number;
    /** Diff image filename (relative to runDir), when a diff was found. */
    diffPath?: string;
    /** Baseline image path used. */
    baselinePath: string;
  };
  /** Token + cost accounting for every LLM call made during the run. */
  usage?: UsageTotals;
  /** Number of attempts made (1 unless retries were configured). */
  attempts?: number;
  /** True if the spec failed at least once but ultimately passed (unstable). */
  flaky?: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The URL the run ended on (may differ from app.url after navigation/redirects). */
  finalUrl?: string;
  /** The document title of the final page. */
  finalTitle?: string;
  /** Directory on disk holding artifacts (screenshots, trace, logs). */
  runDir: string;
  /** Filename of the recorded video (relative to runDir), if recording was on. */
  videoPath?: string;
}
