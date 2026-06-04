import type { RunReport } from "./types.js";
import { hasVisualDiff } from "./report/suite-report.js";

export type QaGate =
  | "a11y"
  | "a11y-critical"
  | "perf"
  | "visual"
  | "requests"
  | "errors"
  | "text"
  | "url"
  | "state"
  | "security"
  | "layout"
  | "downloads"
  | "clipboard"
  | "toast";

const VALID: QaGate[] = ["a11y", "a11y-critical", "perf", "visual", "requests", "errors", "text", "url", "state", "security", "layout", "downloads", "clipboard", "toast"];

/** Parse a comma list like "a11y,visual" into known gates (unknown ones dropped). */
export function parseGates(input: string | undefined): QaGate[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is QaGate => (VALID as string[]).includes(s));
}

/**
 * Return human messages for every QA-dimension breach selected by `gates`.
 * Empty result = the gate passes. Pure/testable.
 *
 * - "a11y": any accessibility violation
 * - "a11y-critical": only critical/serious violations
 * - "perf": any performance-budget breach
 * - "visual": any visual diff or size mismatch
 * - "requests": any unmet network-request expectation (objective, author-declared)
 * - "errors": any error-level runtime diagnostic (uncaught JS exception, console
 *   error, or 5xx response) — zero-tolerance "clean console" gate
 * - "text": any unmet text assertion (a required string missing or a forbidden one present)
 * - "url": any unmet URL assertion (the final URL lacks a required substring or has a forbidden one)
 * - "state": any unmet persisted-state assertion (cookie / storage missing, wrong, or not cleared)
 * - "security": any high/medium missing-security-header finding (low is advisory)
 * - "layout": the final page overflows the viewport horizontally
 * - "downloads": any unmet download assertion
 * - "clipboard": an unmet clipboard assertion
 * - "toast": an unmet toast/status assertion
 */
export function qaGateFailures(reports: RunReport[], gates: QaGate[]): string[] {
  if (!gates.length) return [];
  const out: string[] = [];
  for (const r of reports) {
    const title = r.spec.title;
    if (gates.includes("a11y") && r.a11y?.violations.length) {
      out.push(`${title}: ${r.a11y.violations.length} accessibility violation(s)`);
    } else if (gates.includes("a11y-critical") && r.a11y) {
      const crit = r.a11y.counts.critical + r.a11y.counts.serious;
      if (crit > 0) out.push(`${title}: ${r.a11y.counts.critical} critical / ${r.a11y.counts.serious} serious a11y violation(s)`);
    }
    if (gates.includes("perf") && r.perfBudgetViolations?.length) {
      out.push(`${title}: performance budget exceeded (${r.perfBudgetViolations.map((v) => v.metric).join(", ")})`);
    }
    if (gates.includes("visual") && hasVisualDiff(r)) {
      out.push(`${title}: visual regression (${r.visual?.status})`);
    }
    if (gates.includes("requests")) {
      const unmet = (r.requestChecks ?? []).filter((c) => !c.met);
      for (const c of unmet) {
        const what = [c.method ?? "any", c.url, c.status != null ? `→ ${c.status}` : "", c.bodyIncludes ? `body~"${c.bodyIncludes}"` : "", c.min === 0 ? "(must NOT occur)" : ""]
          .filter(Boolean)
          .join(" ");
        out.push(`${title}: unmet request expectation \`${what}\` (observed ${c.observed})`);
      }
    }
    if (gates.includes("errors")) {
      const errs = (r.diagnostics ?? []).filter((d) => d.level === "error");
      if (errs.length) {
        const total = errs.reduce((n, d) => n + d.count, 0);
        const sample = errs.slice(0, 3).map((d) => d.text).join("; ");
        out.push(`${title}: ${total} runtime error(s) — ${sample}${errs.length > 3 ? " …" : ""}`);
      }
    }
    if (gates.includes("text")) {
      for (const c of (r.textChecks ?? []).filter((t) => !t.met)) {
        out.push(
          c.kind === "present"
            ? `${title}: required text not found — "${c.text}"`
            : `${title}: forbidden text present — "${c.text}"`
        );
      }
    }
    if (gates.includes("url")) {
      for (const c of (r.urlChecks ?? []).filter((u) => !u.met)) {
        out.push(
          c.kind === "contains"
            ? `${title}: final URL missing required substring — "${c.text}"`
            : `${title}: final URL contains forbidden substring — "${c.text}"`
        );
      }
    }
    if (gates.includes("state")) {
      for (const c of (r.stateChecks ?? []).filter((s) => !s.met)) {
        const what = `${c.scope} "${c.key}"`;
        out.push(
          c.absent
            ? `${title}: ${what} should be cleared but is still present`
            : c.value
              ? `${title}: ${what} missing or wrong value (wanted ~"${c.value}")`
              : `${title}: ${what} was not set`
        );
      }
    }
    if (gates.includes("security")) {
      // Gate on high+medium findings; low-severity (info leak / referrer) is advisory.
      const serious = (r.security?.findings ?? []).filter((f) => f.severity !== "low");
      if (serious.length) {
        out.push(`${title}: ${serious.length} security-header issue(s) — ${serious.map((f) => f.id).join(", ")}`);
      }
    }
    if (gates.includes("layout") && r.layout?.horizontalOverflow) {
      out.push(`${title}: horizontal overflow — content ${r.layout.scrollWidth}px vs ${r.layout.clientWidth}px viewport`);
    }
    if (gates.includes("downloads")) {
      for (const c of (r.downloadChecks ?? []).filter((d) => !d.met)) {
        const what = [c.filename ? `"${c.filename}"` : "(any)", c.contentIncludes ? `content~"${c.contentIncludes}"` : ""].filter(Boolean).join(" ");
        out.push(`${title}: unmet download assertion ${what}`);
      }
    }
    if (gates.includes("clipboard") && r.clipboardCheck && !r.clipboardCheck.met) {
      out.push(`${title}: clipboard did not contain "${r.clipboardCheck.expected}"`);
    }
    if (gates.includes("toast") && r.toastCheck && !r.toastCheck.met) {
      out.push(`${title}: no toast/status message contained "${r.toastCheck.expected}"`);
    }
  }
  return out;
}
