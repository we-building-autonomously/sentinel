import type { RunReport, RunCategory } from "../types.js";
import { sumUsage } from "../usage.js";
import { runTriage } from "./suite-report.js";
import { qaGateFailures, type QaGate } from "../qa-gate.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** How each triage category maps to a JUnit testcase outcome. */
type JUnitOutcome = "pass" | "failure" | "error" | "skipped";
const OUTCOME: Record<RunCategory, JUnitOutcome> = {
  passed: "pass",
  "flaky-pass": "pass",
  "product-defect": "failure",
  inconclusive: "error",
  // Environment-class outcomes are NOT code failures — map to <skipped> so CI
  // dashboards render them neutrally (a CAPTCHA wall or a down staging box
  // shouldn't turn the suite red).
  blocked: "skipped",
  "blocked-external": "skipped",
  "app-unavailable": "skipped",
  skipped: "skipped",
};

/**
 * Render a set of run reports as a JUnit XML suite so Sentinel results show up
 * in CI dashboards (GitHub Actions, GitLab, Jenkins, etc.).
 *
 * Outcome is driven by TRIAGE, not the raw verdict, so environment blocks
 * (CAPTCHA, 2FA, app-down) become <skipped> instead of red failures:
 *   product-defect -> <failure> · inconclusive -> <error> ·
 *   blocked/blocked-external/app-unavailable -> <skipped> · pass -> passing.
 */
export function toJUnit(reports: RunReport[], suiteName = "sentinel", gates: QaGate[] = []): string {
  const tests = reports.length;
  const triaged = reports.map((r) => {
    const cat = runTriage(r);
    // A QA-gate breach (a11y/perf/visual/security/... via --fail-on) turns an
    // otherwise-passing testcase into a <failure>, so the JUnit matches the CLI
    // exit code instead of showing green while the build is red.
    const gateFails = gates.length ? qaGateFailures([r], gates).map((m) => m.replace(`${r.spec.title}: `, "")) : [];
    const baseOutcome = OUTCOME[cat.category];
    const outcome: JUnitOutcome = baseOutcome === "pass" && gateFails.length ? "failure" : baseOutcome;
    return { r, cat, outcome, gateFails, gatedPass: baseOutcome === "pass" && gateFails.length > 0 };
  });
  const failures = triaged.filter((x) => x.outcome === "failure").length;
  const errors = triaged.filter((x) => x.outcome === "error").length;
  const skipped = triaged.filter((x) => x.outcome === "skipped").length;
  const time = reports.reduce((s, r) => s + r.durationMs, 0) / 1000;
  const usage = sumUsage(reports.map((r) => r.usage));
  const flaky = reports.filter((r) => r.flaky).length;
  const props = [
    ["cost.usd", usage.costUsd.toFixed(6)],
    ["tokens.input", String(usage.total.input)],
    ["tokens.output", String(usage.total.output)],
    ["tokens.cacheRead", String(usage.total.cacheRead)],
    ["flaky", String(flaky)],
  ]
    .map(([n, v]) => `    <property name="${n}" value="${esc(v)}"/>`)
    .join("\n");

  const cases = triaged
    .map(({ r, outcome, cat, gateFails, gatedPass }) => {
      const v = r.verdict;
      const name = esc(r.spec.title);
      const t = (r.durationMs / 1000).toFixed(3);
      const details = esc(
        [
          `[triage: ${cat.category}] ${cat.reason}`,
          v.summary,
          ...v.checkpoints.map(
            (c) => `[${c.status ?? "unknown"}] ${c.description}${c.evidence ? ` — ${c.evidence}` : ""}`
          ),
          ...(v.issues.length ? ["Issues:", ...v.issues.map((i) => `  - ${i}`)] : []),
          ...(gateFails.length ? ["QA gate breaches:", ...gateFails.map((g) => `  - ${g}`)] : []),
        ].join("\n")
      );
      // When a gate breach upgraded an otherwise-passing test, label it as such.
      const msg = esc(gatedPass ? `QA gate breach: ${gateFails.join("; ")}` : v.summary);
      const failType = gatedPass ? "qa-gate" : cat.category;
      const body =
        outcome === "failure"
          ? `\n    <failure message="${msg}" type="${failType}">${details}</failure>\n  `
          : outcome === "error"
            ? `\n    <error message="${msg}" type="${cat.category}">${details}</error>\n  `
            : outcome === "skipped"
              ? `\n    <skipped message="${esc(`${cat.category}: ${cat.reason}`)}"/>\n  `
              : "";
      return `  <testcase classname="${esc(suiteName)}" name="${name}" time="${t}">${body}</testcase>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">
  <testsuite name="${esc(suiteName)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">
    <properties>
${props}
    </properties>
${cases}
  </testsuite>
</testsuites>`;
}
