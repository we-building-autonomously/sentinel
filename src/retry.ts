import type { RunReport } from "./types.js";

export interface RetryOutcome {
  report: RunReport;
  attempts: number;
  flaky: boolean;
}

/**
 * Run a spec up to `retries`+1 times, stopping at the first pass. A spec that
 * only passes after an earlier non-pass is flagged flaky — an unstable test is
 * a finding in its own right, not a clean green. The returned report is the
 * last attempt, annotated with attempt count and flakiness.
 */
export async function withRetry(
  run: (attempt: number) => Promise<RunReport>,
  retries: number
): Promise<RetryOutcome> {
  const max = Math.max(0, retries) + 1;
  let last!: RunReport;
  let sawNonPass = false;
  let attempts = 0;

  for (let i = 0; i < max; i++) {
    attempts++;
    last = await run(attempts);
    if (last.verdict.decision === "pass") break;
    sawNonPass = true;
  }

  const flaky = last.verdict.decision === "pass" && sawNonPass;
  return { report: annotate(last, attempts, flaky), attempts, flaky };
}

/** Fold attempt/flakiness info into the report's verdict so it shows up everywhere. */
function annotate(report: RunReport, attempts: number, flaky: boolean): RunReport {
  if (attempts <= 1) return { ...report, attempts: 1, flaky: false };
  const issues = [...report.verdict.issues];
  if (flaky) {
    issues.unshift(`FLAKY: failed ${attempts - 1}x then passed on attempt ${attempts} — unstable test or app.`);
  } else if (report.verdict.decision !== "pass") {
    issues.unshift(`Retried ${attempts}x; all attempts non-passing (decision held).`);
  }
  return {
    ...report,
    attempts,
    flaky,
    verdict: { ...report.verdict, issues },
  };
}
