import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { AppMetaSchema, type RunReport, type TestSpec } from "./types.js";
import { pool } from "./pool.js";
import { runSpec, type RunOptions } from "./runner.js";
import { withRetry } from "./retry.js";
import { filterSpecs, shardItems, type SpecFilter, type Shard } from "./filter.js";
import { applyTemplates, makeContext, withVars, type TemplateContext } from "./template.js";
import { slugify } from "./util.js";

/**
 * A suite groups many specs that share an app and run together. Shared `url`,
 * `auth`, and notes are declared once under `defaults` and merged into each
 * spec (spec-level fields win).
 */
export const SuiteSchema = z.object({
  name: z.string(),
  /** Max specs in flight at once. CLI flag and per-run option override this. */
  concurrency: z.number().int().positive().optional(),
  defaults: z
    .object({
      app: AppMetaSchema.partial().optional(),
      maxSteps: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Optional login spec run once before the suite; its authenticated
   * storageState is reused by every other spec (skip per-test login).
   */
  login: z.record(z.unknown()).optional(),
  /** Reuse an existing storageState file instead of (or alongside) `login`. */
  storageState: z.string().optional(),
  /** Stop launching new specs once cumulative LLM cost (USD) reaches this cap. */
  budgetUsd: z.number().positive().optional(),
  /**
   * Run every spec across the CARTESIAN PRODUCT of these axes. Each present axis
   * multiplies the runs: `matrix: { viewport: ["desktop","mobile"], colorScheme:
   * ["light","dark"] }` runs every spec 4× (one per combination), titled
   * `Spec [mobile · dark]`. Axes: viewport, colorScheme (light/dark), locale.
   */
  matrix: z
    .object({
      viewport: z.array(z.string()).optional(),
      colorScheme: z.array(z.enum(["light", "dark"])).optional(),
      locale: z.array(z.string()).optional(),
    })
    .optional(),
  /** Raw specs — validated by TestSpecSchema after defaults are applied. */
  specs: z.array(z.record(z.unknown())).min(1),
});
export type Suite = z.infer<typeof SuiteSchema>;

/** Merge suite defaults into a raw spec; spec-level values take precedence. */
export function applyDefaults(
  raw: Record<string, unknown>,
  defaults: Suite["defaults"]
): Record<string, unknown> {
  if (!defaults) return raw;
  const merged: Record<string, unknown> = { ...raw };
  if (defaults.maxSteps != null && merged.maxSteps == null) merged.maxSteps = defaults.maxSteps;

  const dApp = (defaults.app ?? {}) as Record<string, unknown>;
  const sApp = (raw.app as Record<string, unknown> | undefined) ?? {};
  const app: Record<string, unknown> = { ...dApp, ...sApp };
  const dAuth = dApp.auth as Record<string, unknown> | undefined;
  const sAuth = sApp.auth as Record<string, unknown> | undefined;
  if (dAuth || sAuth) {
    app.auth = { ...(dAuth ?? {}), ...(sAuth ?? {}) };
    const dExtra = dAuth?.extra as Record<string, unknown> | undefined;
    const sExtra = sAuth?.extra as Record<string, unknown> | undefined;
    if (dExtra || sExtra) (app.auth as Record<string, unknown>).extra = { ...dExtra, ...sExtra };
  }
  merged.app = app;
  return merged;
}

/**
 * Data-driven expansion: a spec with a `cases` array runs once per case, with
 * each case's fields exposed as `{{tokens}}` and a `[caseName]` title suffix.
 * `cases: [{ name: "visa", card: "4111…", expect: "Approved" }, …]` turns one
 * spec into N parameterized runs. Returns `[{spec, vars}]`; no cases → one entry
 * with empty vars. The `cases` key is stripped from every produced spec.
 */
export function expandCases(
  spec: Record<string, unknown>
): Array<{ spec: Record<string, unknown>; vars: Record<string, string> }> {
  const cases = spec.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    const { cases: _omit, ...rest } = spec;
    return [{ spec: rest, vars: {} }];
  }
  const baseTitle = (spec.title as string) ?? "spec";
  return cases.map((raw, i) => {
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(c)) if (typeof v === "string") vars[k] = v;
    const caseName = typeof c.name === "string" && c.name.trim() ? c.name.trim() : String(i + 1);
    const { cases: _omit, ...rest } = spec;
    return { spec: { ...rest, title: `${baseTitle} [${caseName}]` }, vars };
  });
}

/** One matrix axis: each value clones a spec, applies a mutation, and adds a label. */
interface MatrixAxis {
  values: string[];
  apply: (spec: Record<string, unknown>, value: string) => Record<string, unknown>;
}

/** Set/merge an `emulate` sub-field on a cloned spec. */
function withEmulate(spec: Record<string, unknown>, patch: Record<string, string>): Record<string, unknown> {
  const emulate = { ...((spec.emulate as Record<string, unknown>) ?? {}), ...patch };
  return { ...spec, emulate };
}

/**
 * Expand specs across the CARTESIAN PRODUCT of the matrix axes (viewport,
 * colorScheme, locale). Each spec is cloned once per combination, the relevant
 * fields set (viewport / emulate.colorScheme / emulate.locale), and a single
 * dot-joined `[mobile · dark · fr-FR]` title suffix added so reports/history
 * keep the variants distinct. No axes → specs unchanged.
 */
export function expandMatrix(
  specs: Record<string, unknown>[],
  matrix: Suite["matrix"]
): Record<string, unknown>[] {
  const axes: MatrixAxis[] = [];
  const viewports = (matrix?.viewport ?? []).filter(Boolean);
  if (viewports.length) axes.push({ values: viewports, apply: (s, v) => ({ ...s, viewport: v }) });
  const schemes = (matrix?.colorScheme ?? []).filter(Boolean);
  if (schemes.length) axes.push({ values: schemes, apply: (s, v) => withEmulate(s, { colorScheme: v }) });
  const locales = (matrix?.locale ?? []).filter(Boolean);
  if (locales.length) axes.push({ values: locales, apply: (s, v) => withEmulate(s, { locale: v }) });
  if (!axes.length) return specs;

  // Cartesian product of the axes → list of [value, value, …] combinations.
  let combos: string[][] = [[]];
  for (const axis of axes) {
    combos = combos.flatMap((combo) => axis.values.map((v) => [...combo, v]));
  }

  const out: Record<string, unknown>[] = [];
  for (const spec of specs) {
    const baseTitle = (spec.title as string) ?? "spec";
    for (const combo of combos) {
      let s = spec;
      combo.forEach((value, i) => (s = axes[i].apply(s, value)));
      out.push({ ...s, title: `${baseTitle} [${combo.join(" · ")}]` });
    }
  }
  return out;
}

/** A skipped report for a spec not run because the suite hit its cost budget. */
function budgetSkipped(spec: Partial<TestSpec>, budgetUsd: number): RunReport {
  const now = new Date().toISOString();
  const title = spec.title ?? "untitled spec";
  return {
    spec: { title, task: spec.task ?? "", intent: spec.intent ?? "", app: spec.app ?? { url: "about:blank" } },
    plan: { goal: title, checkpoints: [] },
    steps: [],
    verdict: {
      decision: "inconclusive",
      confidence: 0,
      summary: `Skipped: the suite reached its $${budgetUsd} cost budget before this spec ran.`,
      checkpoints: [],
      issues: [`Not run — cost budget ($${budgetUsd}) reached.`],
    },
    // Explicit triage: this spec was NOT RUN, not "app unavailable".
    triage: { category: "skipped", reason: `Not run — cost budget ($${budgetUsd}) reached.`, actionable: true },
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    runDir: "",
  };
}

/**
 * Synthesize an inconclusive report so a crashed/skipped spec still appears in
 * output. `category` labels WHY: "blocked" for a crash (default), "skipped"
 * for a spec deliberately not run (e.g. a failed shared login skips dependents).
 */
function errorReport(spec: Partial<TestSpec>, err: unknown, category: "blocked" | "skipped" = "blocked"): RunReport {
  const now = new Date().toISOString();
  const title = spec.title ?? "untitled spec";
  const reason = err instanceof Error ? err.message : String(err);
  return {
    spec: {
      title,
      task: spec.task ?? "",
      intent: spec.intent ?? "",
      app: spec.app ?? { url: "about:blank" },
    },
    plan: { goal: title, checkpoints: [] },
    steps: [],
    verdict: {
      decision: "inconclusive",
      confidence: 0,
      summary:
        category === "skipped" ? reason : `Spec crashed before a verdict: ${reason}`,
      checkpoints: [],
      issues: ["Run aborted by an error — see message above."],
    },
    triage: { category, reason, actionable: true },
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    runDir: "",
  };
}

export interface SuiteOptions {
  concurrency?: number;
  config?: RunOptions["config"];
  /** Re-run a non-passing spec up to this many extra times (flaky detection). */
  retries?: number;
  /** Cost cap (USD); overrides the suite file's budgetUsd. */
  budgetUsd?: number;
  /** Only run specs matching these tags / title pattern. */
  filter?: SpecFilter;
  /** Run only this CI shard of the work (round-robin partition of the specs). */
  shard?: Shard | null;
  /** Shared template context for the whole suite (injectable for tests). */
  templateContext?: TemplateContext;
  onSpecStart?: (title: string, index: number) => void;
  onSpecDone?: (report: RunReport, index: number) => void;
  /** Injectable runner — defaults to the real browser runner (used in tests). */
  runner?: (spec: unknown, options: RunOptions) => Promise<RunReport>;
}

/** Run an entire suite in parallel, isolating per-spec failures. */
export async function runSuite(suiteInput: unknown, options: SuiteOptions = {}): Promise<RunReport[]> {
  const suite = SuiteSchema.parse(suiteInput);
  const run = options.runner ?? runSpec;
  const concurrency = options.concurrency ?? suite.concurrency ?? 3;
  const retries = options.retries ?? 0;
  const selected = filterSpecs(suite.specs, options.filter ?? {});
  // Resolve {{templates}} ONCE for the whole suite so login-once and the specs
  // that follow share the same generated data (e.g. the account just created).
  const tctx = options.templateContext ?? makeContext();
  // Expand data-driven cases first (each gets its own template vars), then the
  // viewport matrix on top. Shard AFTER expansion so each work unit (spec × case
  // × viewport) is the unit of distribution. login-once is not sharded: every
  // worker needs its own authenticated session.
  const expanded = selected.flatMap((s) => {
    const withDefaults = applyDefaults(s, suite.defaults);
    return expandCases(withDefaults).map(({ spec, vars }) => applyTemplates(spec, withVars(tctx, vars)));
  });
  const merged = shardItems(expandMatrix(expanded, suite.matrix), options.shard);

  // Phase 1: optional login-once — run it, capture auth state, reuse downstream.
  let storageState = suite.storageState;
  const preface: RunReport[] = [];
  if (suite.login) {
    const loginSpec = applyTemplates(applyDefaults(suite.login, suite.defaults), tctx);
    const statePath = path.join(os.tmpdir(), `sentinel-state-${slugify(suite.name)}-${Date.now()}.json`);
    options.onSpecStart?.("login (shared)", -1);
    let loginReport: RunReport;
    try {
      loginReport = await run(loginSpec, { config: options.config, saveStorageStateTo: statePath });
    } catch (err) {
      loginReport = errorReport(loginSpec as Partial<TestSpec>, err);
    }
    options.onSpecDone?.(loginReport, -1);
    preface.push(loginReport);
    if (loginReport.verdict.decision === "pass") {
      storageState = statePath;
    } else {
      // Login failed: don't run the rest against an unauthenticated session.
      return [
        loginReport,
        ...merged.map((s) =>
          errorReport(s as Partial<TestSpec>, new Error("Skipped: shared login did not pass."), "skipped")
        ),
      ];
    }
  }

  // Phase 2: run the specs in parallel, each seeded with the shared auth state,
  // retrying non-passing specs to flag flakiness. A cost budget stops launching
  // new specs once cumulative spend is reached (best-effort: specs already in
  // flight finish, so the cap may be overshot by up to `concurrency` runs).
  const budgetUsd = options.budgetUsd ?? suite.budgetUsd;
  let spent = preface.reduce((n, r) => n + (r.usage?.costUsd ?? 0), 0);
  const specReports = await pool(merged, concurrency, async (spec, i) => {
    if (budgetUsd != null && spent >= budgetUsd) {
      const r = budgetSkipped(spec as Partial<TestSpec>, budgetUsd);
      options.onSpecDone?.(r, i);
      return r;
    }
    options.onSpecStart?.((spec.title as string) ?? `spec ${i + 1}`, i);
    const { report } = await withRetry(async () => {
      try {
        return await run(spec, { config: options.config, storageState });
      } catch (err) {
        return errorReport(spec as Partial<TestSpec>, err);
      }
    }, retries);
    spent += report.usage?.costUsd ?? 0;
    options.onSpecDone?.(report, i);
    return report;
  });

  return [...preface, ...specReports];
}

/** Default slug for a suite, used to name aggregate artifacts. */
export function suiteSlug(suite: Suite): string {
  return slugify(suite.name) || "suite";
}
