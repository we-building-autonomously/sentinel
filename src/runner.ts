import fs from "node:fs";
import path from "node:path";
import { loadConfig, type SentinelConfig } from "./config.js";
import { LlmClient } from "./llm/anthropic.js";
import { UsageMeter } from "./usage.js";
import { BrowserSession } from "./browser/session.js";
import { resolveViewport } from "./browser/viewport.js";
import { describeMock } from "./browser/mock.js";
import { runA11y, formatA11y } from "./browser/a11y.js";
import { auditSecurity, formatSecurity } from "./browser/security.js";
import { measureLayout } from "./browser/layout.js";
import { collectPerfMetrics, evaluatePerfBudget } from "./browser/perf-metrics.js";
import { compareScreenshots, formatVisual } from "./browser/visual.js";
import { applyTemplates, makeContext, withVars } from "./template.js";
import { makePlan } from "./agent/planner.js";
import { classifyRun } from "./triage.js";
import { evaluateRequestExpectations } from "./browser/expect-requests.js";
import { evaluateTextExpectations } from "./browser/expect-text.js";
import { evaluateUrlExpectations } from "./browser/expect-url.js";
import { evaluateStateExpectations } from "./browser/expect-state.js";
import { runHooks } from "./hooks.js";
import { evaluateDownloadExpectations } from "./browser/expect-download.js";
import { runAgent } from "./agent/loop.js";
import { judge, shouldVisionJudge } from "./agent/judge.js";
import { containsSecret } from "./report/secrets.js";
import { writeReports } from "./report/reporter.js";
import { TestSpecSchema, type TestSpec, type RunReport, type Step, type Plan } from "./types.js";
import { slugify } from "./util.js";

/** Resolve a spec clock `now` (ISO string or epoch ms) to epoch ms, or undefined. */
export function resolveClock(now: string | number | undefined): number | undefined {
  if (now == null) return undefined;
  const ms = typeof now === "number" ? now : Date.parse(now);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Build the credentials/notes context handed to the agent (not written to disk). */
export function buildContext(spec: TestSpec): string | undefined {
  const lines: string[] = [];
  if (spec.app.notes) lines.push(`App notes: ${spec.app.notes}`);
  const auth = spec.app.auth;
  if (auth) {
    const bits: string[] = [];
    if (auth.strategy) bits.push(`Login strategy: ${auth.strategy}`);
    if (auth.username) bits.push(`Username/email: ${auth.username}`);
    if (auth.password) bits.push(`Password: ${auth.password}`);
    if (auth.totpSecret)
      bits.push(
        "Two-factor auth is enabled — when prompted for a 2FA/authenticator code, call the get_totp tool to get the current code, then type it."
      );
    for (const [k, v] of Object.entries(auth.extra ?? {})) bits.push(`${k}: ${v}`);
    if (bits.length)
      lines.push(
        "Credentials for this test (use them to authenticate when the app requires it):\n" +
          bits.map((b) => `  - ${b}`).join("\n")
      );
  }
  const emu = spec.emulate;
  if (emu) {
    const bits = [
      emu.colorScheme === "dark" ? "dark mode (prefers-color-scheme: dark)" : "",
      emu.reducedMotion === "reduce" ? "reduced motion" : "",
      emu.locale ? `locale ${emu.locale} (UI text and date/number formats may be localized)` : "",
      emu.timezoneId ? `timezone ${emu.timezoneId} (displayed dates/times are in this zone)` : "",
    ].filter(Boolean);
    if (bits.length)
      lines.push(`The browser is emulating: ${bits.join(", ")}. Expect the app to render accordingly.`);
  }
  const clockMs = resolveClock(spec.clock?.now);
  if (clockMs != null)
    lines.push(
      `The browser clock is frozen to ${new Date(clockMs).toISOString()} — treat that as "now" (the app's "today", timestamps and countdowns reflect it).`
    );
  return lines.length ? "APP CONTEXT:\n" + lines.join("\n") : undefined;
}

/**
 * Visual regression: screenshot the final page and compare to a baseline. On
 * first run (no baseline) the baseline is captured. Otherwise a pixel diff is
 * computed and a diff image saved when it regresses.
 */
async function runVisual(
  session: BrowserSession,
  spec: TestSpec,
  id: string,
  cfg: SentinelConfig,
  runDir: string
): Promise<RunReport["visual"]> {
  const maxDiffRatio = typeof spec.visual === "object" ? spec.visual.maxDiffRatio : undefined;
  const baselinePath = path.join(cfg.baselinesDir, `${id}.png`);
  const current = await session.screenshotBuffer(true);

  if (!fs.existsSync(baselinePath)) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, current);
    return { status: "new-baseline", diffRatio: 0, mismatchedPixels: 0, baselinePath };
  }

  const baseline = fs.readFileSync(baselinePath);
  const result = compareScreenshots(baseline, current, { maxDiffRatio });
  let diffPath: string | undefined;
  if (result.diffPng) {
    diffPath = "visual-diff.png";
    fs.writeFileSync(path.join(runDir, diffPath), result.diffPng);
    fs.writeFileSync(path.join(runDir, "visual-current.png"), current);
  }
  return {
    status: result.status,
    diffRatio: result.diffRatio,
    mismatchedPixels: result.mismatchedPixels,
    diffPath,
    baselinePath,
  };
}

/** Synthetic verdict for an app that couldn't be loaded at all. */
function unreachableVerdict(url: string, error?: string): RunReport["verdict"] {
  return {
    decision: "inconclusive",
    confidence: 0.95,
    summary: `Could not load ${url}${error ? ` — ${error}` : ""}. The app appears unreachable, so the task could not be attempted.`,
    checkpoints: [],
    issues: [`Navigation to ${url} failed${error ? `: ${error}` : ""}.`],
  };
}

export interface RunOptions {
  config?: Partial<SentinelConfig>;
  onStep?: (step: Step) => void;
  onPhase?: (phase: string) => void;
  /** Fired once the run directory exists — lets a live viewer locate per-step artifacts. */
  onStart?: (info: { runDir: string }) => void;
  /** Seed the browser with this Playwright storageState (skip re-login). */
  storageState?: string;
  /** After the run, persist cookies + localStorage to this path. */
  saveStorageStateTo?: string;
  /** Per-case template variables for a data-driven spec (see suite `cases`). */
  vars?: Record<string, string>;
  /**
   * Inject the LLM clients (actor + judge). Used by integration tests to drive
   * the real pipeline deterministically without an API key. Production code
   * leaves this undefined and real clients are built from config.
   */
  clients?: { llm: LlmClient; judge: LlmClient };
}

/** Run a single test spec end-to-end and return the full report. */
export async function runSpec(specInput: unknown, options: RunOptions = {}): Promise<RunReport> {
  // Resolve {{randomEmail}} / {{uuid}} / {{env.X}} etc. once, before validation,
  // so data-creation tests get fresh values each run and can target any env.
  // `options.vars` carries per-case data for data-driven specs.
  const rendered = applyTemplates(specInput, withVars(makeContext(), options.vars ?? {}));
  const spec = TestSpecSchema.parse(rendered);
  const cfg = loadConfig(options.config);
  const startedAt = new Date();
  const id = spec.id ?? slugify(spec.title) ?? "test";
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const runDir = path.resolve(cfg.runsDir, `${id}-${stamp}`);
  fs.mkdirSync(runDir, { recursive: true });
  options.onStart?.({ runDir });

  const meter = new UsageMeter();
  const llm = options.clients?.llm ?? new LlmClient(cfg.apiKey, cfg.model, meter);
  const judgeLlm = options.clients?.judge ?? new LlmClient(cfg.apiKey, cfg.judgeModel, meter);

  const vp = resolveViewport(spec.viewport);
  const session = new BrowserSession({
    headed: cfg.headed,
    actionTimeoutMs: cfg.actionTimeoutMs,
    artifactsDir: runDir,
    storageState: options.storageState,
    video: cfg.video,
    viewport: vp.viewport,
    userAgent: vp.userAgent,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor,
    extraHTTPHeaders: spec.app.headers,
    httpCredentials: spec.app.httpCredentials,
    // Playwright needs url OR domain+path; default url to the app URL.
    cookies: spec.app.cookies?.map((ck) =>
      ck.url || ck.domain ? ck : { ...ck, url: spec.app.url }
    ),
    mocks: spec.mocks,
    uploads: spec.uploads,
    totpSecret: spec.app.auth?.totpSecret,
    colorScheme: spec.emulate?.colorScheme,
    reducedMotion: spec.emulate?.reducedMotion,
    locale: spec.emulate?.locale,
    timezoneId: spec.emulate?.timezoneId,
    clockNow: resolveClock(spec.clock?.now),
  });

  // State isolation: fire setup hooks BEFORE touching the browser. A failed
  // setup means the test can't run against a prepared state — block it cleanly
  // (no browser, no LLM spend) rather than testing against dirty/missing data.
  const setupResults = await runHooks(spec.setup, { stopOnError: true });
  const setupFailure = setupResults.find((r) => !r.ok);

  // Best-effort cleanup that ALWAYS runs exactly once: close the browser, then
  // fire teardown hooks (capturing their results). Invoked from the run's
  // finally so it happens on success, on an unreachable app, AND on a crash —
  // cleanup that gets skipped is useless.
  let teardownResults: typeof setupResults = [];
  let cleanedUp = false;
  const closeAndTeardown = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await session.close();
    teardownResults = await runHooks(spec.teardown);
  };

  // Finalize a report: attach hook results + the (post-close) video, write it.
  const finish = (rep: RunReport): RunReport => {
    if (setupResults.length || teardownResults.length) {
      rep.hooks = {
        ...(setupResults.length ? { setup: setupResults } : {}),
        ...(teardownResults.length ? { teardown: teardownResults } : {}),
      };
    }
    if (session.videoFile) rep.videoPath = session.videoFile;
    options.onPhase?.("reporting");
    writeReports(rep);
    return rep;
  };

  if (setupFailure) {
    const finishedAt = new Date();
    // No browser was started; still clean up any partial setup via teardown.
    cleanedUp = true;
    teardownResults = await runHooks(spec.teardown);
    return finish({
      spec,
      plan: { goal: spec.intent, checkpoints: [] },
      steps: [],
      verdict: {
        decision: "inconclusive",
        confidence: 0,
        summary: `Setup hook failed (${setupFailure.method} ${setupFailure.url}: ${setupFailure.error}). The test could not run against a prepared state.`,
        checkpoints: [],
        issues: [`Setup hook failed: ${setupFailure.error}`],
      },
      triage: { category: "blocked", reason: `Setup hook failed: ${setupFailure.error}`, actionable: true },
      usage: meter.totals(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      runDir,
    });
  }

  let report: RunReport;
  try {
    await session.start();
    options.onPhase?.("navigating");
    const nav = await session.goto(spec.app.url);

    // App unreachable -> short-circuit with a clear verdict, no LLM calls.
    if (!nav.ok) {
      const finishedAt = new Date();
      report = {
        spec,
        plan: { goal: spec.intent, checkpoints: [] },
        steps: [],
        verdict: unreachableVerdict(spec.app.url, nav.error),
        diagnostics: session.diags(),
        usage: meter.totals(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        runDir,
      };
      report.triage = classifyRun(report);
      await closeAndTeardown();
      return finish(report);
    }

    // Capture initial-load performance right after navigation (before the agent
    // mutates the page), so the metrics reflect the app's cold load.
    const perfMetrics = await collectPerfMetrics(session.page);
    const perfBudgetViolations = spec.perfBudget
      ? evaluatePerfBudget(perfMetrics, spec.perfBudget)
      : [];

    options.onPhase?.("planning");
    let plan: Plan;
    try {
      plan = await makePlan(llm, spec);
    } catch (err) {
      // A planner-phase model failure (API down, no credits, rate limit) must
      // not crash the run with no output — degrade to an inconclusive report
      // that records what happened, like the judge/agent failure paths do.
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      const finishedAt = new Date();
      report = {
        spec,
        plan: { goal: spec.intent, checkpoints: [] },
        steps: [],
        verdict: {
          decision: "inconclusive",
          confidence: 0,
          summary: `The test plan could not be generated — the model call failed (${msg}). No browser actions were taken; re-run once the model is reachable.`,
          checkpoints: [],
          issues: [`Planner model error: ${msg}`],
        },
        triage: { category: "inconclusive", reason: `Planner model call failed: ${msg}`, actionable: true },
        diagnostics: session.diags(),
        perfMetrics,
        perfBudgetViolations: perfBudgetViolations.length ? perfBudgetViolations : undefined,
        usage: meter.totals(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        finalUrl: session.page.url(),
        runDir,
      };
      await closeAndTeardown();
      return finish(report);
    }

    // A 4xx/5xx landing status is surfaced to the agent rather than assumed bad.
    const navNote =
      nav.status && nav.status >= 400
        ? `Note: the initial page load returned HTTP ${nav.status}. Verify whether this is expected for the task or an app fault.`
        : undefined;
    const vpNote =
      vp.label !== "desktop"
        ? `You are testing at the ${vp.label} viewport (${vp.viewport.width}×${vp.viewport.height}${vp.isMobile ? ", mobile/touch" : ""}). Expect a responsive/mobile layout (hamburger menus, stacked content).`
        : undefined;
    const mockNote = spec.mocks?.length
      ? `Network stubs are active for this test — treat the resulting states as real:\n${spec.mocks
          .map((m) => `  - ${describeMock(m)}`)
          .join("\n")}`
      : undefined;
    const uploadNote = spec.uploads?.length
      ? `${spec.uploads.length} file(s) are available for upload — when the task needs a file, click the upload control / file input and the file is supplied automatically.`
      : undefined;

    options.onPhase?.("executing");
    const maxSteps = spec.maxSteps ?? cfg.maxSteps;
    const run = await runAgent({
      llm,
      session,
      plan,
      maxSteps,
      maxDurationMs: cfg.maxDurationMs,
      context: [buildContext(spec), vpNote, mockNote, uploadNote, navNote].filter(Boolean).join("\n\n") || undefined,
      onStep: options.onStep,
    });

    // Optional accessibility audit of the final page.
    let a11y: import("./browser/a11y.js").A11yResult | undefined;
    if (spec.a11y) {
      options.onPhase?.("a11y");
      a11y = await runA11y(session.page);
    }

    // Optional security audit: main-document response headers + session-cookie flags.
    const security = spec.security
      ? auditSecurity({
          headers: session.mainResponseHeaders(),
          cookies: await session.cookies(),
          https: spec.app.url.startsWith("https:"),
        })
      : undefined;

    // Optional visual-regression check against a saved baseline.
    let visual: RunReport["visual"];
    if (spec.visual) {
      options.onPhase?.("visual");
      visual = await runVisual(session, spec, id, cfg, runDir);
    }

    options.onPhase?.("judging");
    const finalSnap = await session.snapshot();
    // Responsive-layout check: does the final page scroll horizontally?
    const layout = await measureLayout(session.page);
    // Evaluate declared network-request expectations against the observed log.
    const requestChecks = spec.expectRequests?.length
      ? evaluateRequestExpectations(session.requestLog(), spec.expectRequests)
      : [];
    // Deterministic text assertions on the final page (present / forbidden).
    const textChecks =
      spec.expectText?.length || spec.forbidText?.length
        ? evaluateTextExpectations(finalSnap.text, { expect: spec.expectText, forbid: spec.forbidText })
        : [];
    // Deterministic URL assertions on the final page (did the flow redirect right?).
    const urlChecks =
      spec.expectUrl?.length || spec.forbidUrl?.length
        ? evaluateUrlExpectations(finalSnap.url, { expect: spec.expectUrl, forbid: spec.forbidUrl })
        : [];
    // Persisted-state assertions: cookies + local/session storage after the run.
    const stateChecks = spec.expectState?.length
      ? evaluateStateExpectations(await session.stateSnapshot(), spec.expectState)
      : [];
    // Download assertions: read each saved file's text and verify name/content.
    const downloadChecks = spec.expectDownloads?.length
      ? evaluateDownloadExpectations(
          session.downloadRecords().map((d) => ({
            filename: d.filename,
            content: d.path
              ? (() => {
                  try {
                    return fs.readFileSync(path.join(runDir, d.path!), "utf8").slice(0, 20_000);
                  } catch {
                    return undefined;
                  }
                })()
              : undefined,
          })),
          spec.expectDownloads
        )
      : [];
    // Transient toast / status announcements that may have vanished by now.
    const liveAnnouncements = await session.liveAnnouncements();
    const toastCheck = spec.expectToast
      ? { expected: spec.expectToast, met: liveAnnouncements.some((a) => a.includes(spec.expectToast!)) }
      : undefined;
    // Clipboard assertion: did the app copy the expected substring?
    const clipboardCheck = spec.expectClipboard
      ? {
          expected: spec.expectClipboard,
          met: (await session.clipboardWrites()).some((w) => w.includes(spec.expectClipboard!)),
        }
      : undefined;
    // Author-declared deterministic assertions that came back UNMET. These are
    // objective acceptance criteria — passed to the judge so a contradictory
    // "pass" is reconciled down to "fail" regardless of how the judge weighed them.
    const assertionFailures: string[] = [
      ...textChecks,
      ...urlChecks,
      ...stateChecks,
      ...requestChecks,
      ...downloadChecks,
    ]
      .filter((c) => !c.met)
      .map((c) => c.detail);
    if (clipboardCheck && !clipboardCheck.met)
      assertionFailures.push(`clipboard did not contain "${clipboardCheck.expected}"`);
    if (toastCheck && !toastCheck.met)
      assertionFailures.push(`no toast/status message contained "${toastCheck.expected}"`);

    // For visual-intent tests, let the judge SEE the final page — but never when
    // a secret is on screen (the image would carry it past text redaction).
    const judgeShot =
      shouldVisionJudge(spec) && !containsSecret(finalSnap.text)
        ? await session.screenshotBase64().then((s) => ({ data: s.data, mediaType: s.mediaType })).catch(() => null)
        : null;
    // The judge needs an LLM call too. If it fails terminally (API down), don't
    // lose the whole run — fall back to an inconclusive verdict that still
    // reports everything the agent observed.
    let verdict: RunReport["verdict"];
    try {
      verdict = await judge({
        llm: judgeLlm,
        spec,
        plan,
        steps: run.steps,
        done: run.done,
        exhausted: run.exhausted,
        finalPageText: finalSnap.text,
        finalUrl: finalSnap.url,
        finalTitle: finalSnap.title,
        screenshot: judgeShot,
        errorState: finalSnap.errorState ?? null,
        requestChecks: requestChecks.length ? requestChecks.map((c) => c.detail) : undefined,
        textChecks: textChecks.length ? textChecks.map((c) => c.detail) : undefined,
        urlChecks: urlChecks.length ? urlChecks.map((c) => c.detail) : undefined,
        stateChecks: stateChecks.length ? stateChecks.map((c) => c.detail) : undefined,
        assertionFailures: assertionFailures.length ? assertionFailures : undefined,
        downloadChecks: downloadChecks.length ? downloadChecks.map((c) => c.detail) : undefined,
        clipboardCheck: clipboardCheck
          ? `${clipboardCheck.met ? "met" : "UNMET"}: clipboard should contain "${clipboardCheck.expected}"`
          : undefined,
        liveAnnouncements: liveAnnouncements.length ? liveAnnouncements : undefined,
        toastCheck: toastCheck
          ? `${toastCheck.met ? "met" : "UNMET"}: a toast/status message should contain "${toastCheck.expected}"`
          : undefined,
        diagnostics: session.diagnostics.forJudge(),
        dialogs: session.dialogRecords(),
        downloads: session.downloadRecords().length
          ? session.downloadRecords().map((d) => ({ filename: d.filename, bytes: d.bytes, error: d.error }))
          : undefined,
        mockActivity: spec.mocks?.length ? session.mockActivity() : undefined,
        a11y: a11y && a11y.violations.length ? formatA11y(a11y) : undefined,
        layout: layout.horizontalOverflow
          ? `the page is ${layout.scrollWidth}px wide but the viewport is ${layout.clientWidth}px — content overflows horizontally`
          : undefined,
        security:
          security && security.findings.length
            ? `${formatSecurity(security)} (${security.findings.map((f) => `${f.severity}: ${f.id}`).join("; ")})`
            : undefined,
        perfBudget: perfBudgetViolations.length
          ? perfBudgetViolations.map((v) => `${v.metric} ${v.actual}ms exceeds budget ${v.budget}ms`).join("; ")
          : undefined,
        visual:
          visual && (visual.status === "diff" || visual.status === "size-mismatch")
            ? `${visual.status} — ${(visual.diffRatio * 100).toFixed(2)}% of pixels changed vs baseline`
            : undefined,
        model: cfg.judgeModel,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      verdict = {
        decision: "inconclusive",
        confidence: 0,
        summary: `The verdict could not be rendered — the judge model call failed (${msg}). The agent's run was recorded; re-run to adjudicate.`,
        checkpoints: plan.checkpoints.map((c) => ({ ...c, status: "unknown" as const })),
        issues: [`Judge model error: ${msg}`],
      };
    }

    // A secret appeared on screen during the run (per-step screenshots of it
    // were already suppressed). If video was recording, it still captured the
    // frames — disclose that honestly in the verdict.
    if (cfg.video && run.steps.some((s) => /screenshot withheld/.test(s.result.summary))) {
      verdict.issues = [
        "⚠ A secret was visible on the page during the run; the recorded video may contain it — handle the video as sensitive.",
        ...verdict.issues,
      ];
    }

    const finishedAt = new Date();
    report = {
      spec,
      plan,
      steps: run.steps,
      verdict,
      diagnostics: session.diags(),
      dialogs: session.dialogRecords(),
      downloads: session.downloadRecords().length ? session.downloadRecords() : undefined,
      uploads: session.uploads().length ? session.uploads() : undefined,
      mockActivity: spec.mocks?.length ? session.mockActivity() : undefined,
      requestChecks: requestChecks.length
        ? requestChecks.map((c) => ({
            url: c.expectation.url,
            method: c.expectation.method,
            status: c.expectation.status,
            bodyIncludes: c.expectation.bodyIncludes,
            min: c.expectation.min,
            observed: c.observed,
            met: c.met,
          }))
        : undefined,
      textChecks: textChecks.length
        ? textChecks.map((c) => ({ kind: c.kind, text: c.text, found: c.found, met: c.met }))
        : undefined,
      urlChecks: urlChecks.length
        ? urlChecks.map((c) => ({ kind: c.kind, text: c.text, found: c.found, met: c.met }))
        : undefined,
      stateChecks: stateChecks.length
        ? stateChecks.map((c) => ({ scope: c.scope, key: c.key, value: c.value, absent: c.absent, present: c.present, met: c.met }))
        : undefined,
      downloadChecks: downloadChecks.length
        ? downloadChecks.map((c) => ({ filename: c.expectation.filename, contentIncludes: c.expectation.contentIncludes, met: c.met }))
        : undefined,
      clipboardCheck,
      liveAnnouncements: liveAnnouncements.length ? liveAnnouncements : undefined,
      toastCheck,
      a11y,
      layout: layout.horizontalOverflow ? layout : undefined,
      security,
      visual,
      perfMetrics,
      perfBudgetViolations: perfBudgetViolations.length ? perfBudgetViolations : undefined,
      usage: meter.totals(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      finalUrl: finalSnap.url,
      finalTitle: finalSnap.title,
      runDir,
    };
    report.triage = classifyRun(report);

    if (options.saveStorageStateTo) {
      await session.saveStorageState(options.saveStorageStateTo);
    }
  } finally {
    // Always close the browser and run teardown — on success, on the
    // unreachable short-circuit (no-op, already ran), and on a crash.
    await closeAndTeardown();
  }

  // Normal completion: video + hooks are known now the context has closed.
  return finish(report);
}
