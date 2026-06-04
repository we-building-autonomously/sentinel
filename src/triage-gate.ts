import type { RunReport, RunCategory } from "./types.js";
import { runTriage } from "./report/suite-report.js";

/** Every triage category that can be named in a --fail-on-triage gate. */
export const TRIAGE_CATEGORIES: RunCategory[] = [
  "passed",
  "flaky-pass",
  "product-defect",
  "blocked-external",
  "blocked",
  "app-unavailable",
  "inconclusive",
  "skipped",
];

/**
 * Parse a comma list like "product-defect,blocked" into known categories
 * (unknown tokens dropped, case-insensitive, deduped). An "actionable" alias
 * expands to every category that needs a human — handy for the common CI case
 * of "fail on anything that isn't a clean pass".
 */
export function parseTriageCategories(input: string | undefined): RunCategory[] {
  if (!input) return [];
  const valid = new Set<string>(TRIAGE_CATEGORIES);
  const out = new Set<RunCategory>();
  for (const tokRaw of input.split(",")) {
    const tok = tokRaw.trim().toLowerCase();
    if (!tok) continue;
    if (tok === "actionable") {
      for (const c of TRIAGE_CATEGORIES) if (c !== "passed") out.add(c);
    } else if (valid.has(tok)) {
      out.add(tok as RunCategory);
    }
  }
  return [...out];
}

/**
 * Return a human message for every run whose triage category is in `categories`.
 * Empty result = the gate passes. Lets CI fail the build on genuine product
 * defects while leaving environment-class outcomes (a CAPTCHA wall, a down
 * staging box) non-blocking. Pure/testable.
 */
export function triageGateFailures(reports: RunReport[], categories: RunCategory[]): string[] {
  if (!categories.length) return [];
  const want = new Set(categories);
  const out: string[] = [];
  for (const r of reports) {
    const t = runTriage(r);
    if (want.has(t.category)) out.push(`${r.spec.title}: ${t.category} — ${t.reason}`);
  }
  return out;
}
