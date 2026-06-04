import fs from "node:fs";
import type { RunReport, RunCategory } from "../types.js";
import { runTriage, toSuiteMarkdown } from "./suite-report.js";

/**
 * GitHub Actions integration. When Sentinel runs in a workflow we want results
 * on the two surfaces a reviewer actually sees:
 *   1. The job summary (rendered markdown on the run page) — appended to the
 *      file at $GITHUB_STEP_SUMMARY.
 *   2. Workflow annotations (::error/::warning::) on stdout — surfaced inline in
 *      the run log and on the PR.
 *
 * Pure functions build the strings; `emitGithub` does the (injectable) IO so it
 * is unit-testable without real env/fs.
 */

/** GitHub workflow-command severity per triage category. */
const LEVEL: Record<RunCategory, "error" | "warning" | "notice" | null> = {
  "product-defect": "error",
  "blocked-external": "warning",
  blocked: "warning",
  "app-unavailable": "warning",
  inconclusive: "warning",
  skipped: null,
  "flaky-pass": "notice",
  passed: null,
};

// Workflow-command escaping (https://docs.github.com/actions ... workflow-commands).
const escData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * Build the `::error/::warning/::notice::` annotation lines for the runs that
 * need attention (a clean pass / skipped emits nothing). Single line each.
 */
export function workflowAnnotations(reports: RunReport[]): string[] {
  const out: string[] = [];
  for (const r of reports) {
    const t = runTriage(r);
    const level = LEVEL[t.category];
    if (!level) continue;
    const title = `Sentinel: ${r.spec.title}`;
    const msg = (t.reason || r.verdict.summary || r.verdict.decision).replace(/\s+/g, " ").trim();
    out.push(`::${level} title=${escProp(title)}::${escData(msg)}`);
  }
  return out;
}

export interface GithubEnv {
  GITHUB_ACTIONS?: string;
  GITHUB_STEP_SUMMARY?: string;
}

/** True when running inside a GitHub Actions job. */
export function isGithubActions(env: GithubEnv): boolean {
  return env.GITHUB_ACTIONS === "true";
}

export interface EmitGithubOptions {
  reports: RunReport[];
  suiteName: string;
  env: GithubEnv;
  /** Append the job summary to the $GITHUB_STEP_SUMMARY file (default: fs). */
  appendFile?: (path: string, data: string) => void;
  /** Emit an annotation line to stdout (default: console.log). */
  log?: (line: string) => void;
}

/**
 * Write the job summary (if $GITHUB_STEP_SUMMARY is set) and print annotations.
 * Returns what it did, for the caller to log. A failure to write the summary is
 * swallowed (never break a run over a reporting side-effect).
 */
export function emitGithub(opts: EmitGithubOptions): { summaryWritten: boolean; annotations: number } {
  const { reports, suiteName, env } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const annotations = workflowAnnotations(reports);
  for (const a of annotations) log(a);

  let summaryWritten = false;
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      const append = opts.appendFile ?? ((p: string, d: string) => fs.appendFileSync(p, d));
      append(summaryPath, toSuiteMarkdown(suiteName, reports) + "\n");
      summaryWritten = true;
    } catch {
      // Reporting is best-effort; a write failure must not fail the run.
    }
  }
  return { summaryWritten, annotations: annotations.length };
}
