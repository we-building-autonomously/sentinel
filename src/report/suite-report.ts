import fs from "node:fs";
import path from "node:path";
import type { RunReport, Decision, RunCategory, Triage } from "../types.js";
import { sumUsage, formatUsage } from "../usage.js";
import { classifyRun } from "../triage.js";

export interface SuiteSummary {
  total: number;
  pass: number;
  fail: number;
  inconclusive: number;
  flaky: number;
  durationMs: number;
  /** Total accessibility violations across all runs. */
  a11yViolations: number;
  /** Runs that exceeded their performance budget. */
  perfBreaches: number;
  /** Runs with a visual regression (diff or size-mismatch). */
  visualDiffs: number;
  /** Runs whose final page overflowed the viewport horizontally. */
  layoutIssues: number;
  /** Runs with at least one high/medium security-header finding. */
  securityIssues: number;
  /** Runs that logged an error-level runtime diagnostic (JS exception / 5xx). */
  runtimeErrors: number;
  /** Runs with an unmet network-request OR text assertion. */
  failedAssertions: number;
  /** Count of runs per triage category (routing breakdown). */
  triage: Record<RunCategory, number>;
  /** Runs that need a human to look (everything except a clean pass). */
  actionable: number;
}

/** A run's triage, falling back to classifying on the fly if not pre-computed. */
export function runTriage(r: RunReport): Triage {
  return r.triage ?? classifyRun(r);
}

/** Display metadata per category, ordered most-urgent first for rollups. */
const CATEGORY_META: Record<RunCategory, { emoji: string; label: string }> = {
  "product-defect": { emoji: "🐛", label: "product defect" },
  "blocked-external": { emoji: "🚧", label: "blocked (external)" },
  blocked: { emoji: "⛔", label: "blocked" },
  "app-unavailable": { emoji: "📡", label: "app unavailable" },
  inconclusive: { emoji: "❔", label: "inconclusive" },
  skipped: { emoji: "⊘", label: "skipped" },
  "flaky-pass": { emoji: "🟠", label: "flaky" },
  passed: { emoji: "🟢", label: "passed" },
};
/** Categories worth surfacing in a rollup, in priority order (excludes passed). */
const ROLLUP_ORDER = Object.keys(CATEGORY_META).filter((c) => c !== "passed") as RunCategory[];

const ZERO_TRIAGE = (): Record<RunCategory, number> =>
  Object.fromEntries(Object.keys(CATEGORY_META).map((k) => [k, 0])) as Record<RunCategory, number>;

/** Does a run carry a visual regression? */
export function hasVisualDiff(r: RunReport): boolean {
  return r.visual?.status === "diff" || r.visual?.status === "size-mismatch";
}

/** Split a matrix variant title ("Checkout [mobile]") into base + variant. */
export function parseVariant(title: string): { base: string; variant?: string } {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(title);
  return m ? { base: m[1].trim(), variant: m[2].trim() } : { base: title };
}

/** Stable sort that clusters matrix variants under their base spec. */
function clusterByBase(reports: RunReport[]): RunReport[] {
  return reports
    .map((r, i) => ({ r, i, ...parseVariant(r.spec.title) }))
    .sort((a, b) => a.base.localeCompare(b.base) || a.i - b.i)
    .map((x) => x.r);
}

export function summarize(reports: RunReport[]): SuiteSummary {
  const count = (d: Decision) => reports.filter((r) => r.verdict.decision === d).length;
  const triage = ZERO_TRIAGE();
  let actionable = 0;
  for (const r of reports) {
    const t = runTriage(r);
    triage[t.category]++;
    if (t.actionable) actionable++;
  }
  return {
    total: reports.length,
    pass: count("pass"),
    fail: count("fail"),
    inconclusive: count("inconclusive"),
    flaky: reports.filter((r) => r.flaky).length,
    durationMs: reports.reduce((s, r) => s + r.durationMs, 0),
    a11yViolations: reports.reduce((n, r) => n + (r.a11y?.violations.length ?? 0), 0),
    perfBreaches: reports.filter((r) => r.perfBudgetViolations?.length).length,
    visualDiffs: reports.filter(hasVisualDiff).length,
    layoutIssues: reports.filter((r) => r.layout?.horizontalOverflow).length,
    securityIssues: reports.filter((r) => (r.security?.counts.high ?? 0) + (r.security?.counts.medium ?? 0) > 0).length,
    runtimeErrors: reports.filter((r) => (r.diagnostics ?? []).some((d) => d.level === "error")).length,
    failedAssertions: reports.filter(
      (r) =>
        (r.requestChecks ?? []).some((c) => !c.met) ||
        (r.textChecks ?? []).some((c) => !c.met) ||
        (r.urlChecks ?? []).some((c) => !c.met) ||
        (r.stateChecks ?? []).some((c) => !c.met) ||
        (r.downloadChecks ?? []).some((c) => !c.met) ||
        r.clipboardCheck?.met === false ||
        r.toastCheck?.met === false
    ).length,
    triage,
    actionable,
  };
}

/** Render the triage rollup as "🐛 3 product defect · 🚧 1 blocked (external)" (non-zero only). */
export function triageRollup(s: SuiteSummary): string {
  return ROLLUP_ORDER.filter((c) => s.triage[c] > 0)
    .map((c) => `${CATEGORY_META[c].emoji} ${s.triage[c]} ${CATEGORY_META[c].label}`)
    .join(" · ");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const DOT: Record<Decision, string> = { pass: "🟢", fail: "🔴", inconclusive: "🟡" };

export function toSuiteMarkdown(suiteName: string, reports: RunReport[]): string {
  const s = summarize(reports);
  const lines = [
    `# ${suiteName} — ${s.pass}/${s.total} passed`,
    "",
    `🟢 ${s.pass} pass · 🔴 ${s.fail} fail · 🟡 ${s.inconclusive} inconclusive · ${(s.durationMs / 1000).toFixed(1)}s total`,
    ...(s.actionable
      ? ["", `Triage (${s.actionable} need attention): ${triageRollup(s)}`]
      : []),
    ...(s.a11yViolations || s.perfBreaches || s.visualDiffs || s.securityIssues || s.runtimeErrors || s.failedAssertions || s.layoutIssues
      ? [
          "",
          `QA: ${[
            s.a11yViolations ? `♿ ${s.a11yViolations} a11y` : "",
            s.perfBreaches ? `⚡ ${s.perfBreaches} perf` : "",
            s.visualDiffs ? `🖼 ${s.visualDiffs} visual` : "",
            s.layoutIssues ? `📐 ${s.layoutIssues} layout` : "",
            s.securityIssues ? `🔒 ${s.securityIssues} security` : "",
            s.runtimeErrors ? `💥 ${s.runtimeErrors} runtime-error` : "",
            s.failedAssertions ? `🚩 ${s.failedAssertions} assertion` : "",
          ]
            .filter(Boolean)
            .join(" · ")}`,
        ]
      : []),
    "",
    "| Result | Test | Triage | Conf | Steps | Time |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of reports) {
    const v = r.verdict;
    const t = runTriage(r);
    // Only label rows that need attention — a clean pass leaves the cell blank.
    const cat = t.category === "passed" ? "" : `${CATEGORY_META[t.category].emoji} ${CATEGORY_META[t.category].label}`;
    lines.push(
      `| ${DOT[v.decision]} ${v.decision} | ${r.spec.title} | ${cat} | ${(v.confidence * 100).toFixed(0)}% | ${r.steps.length} | ${(r.durationMs / 1000).toFixed(1)}s |`
    );
  }
  return lines.join("\n");
}

export function toSuiteHtml(suiteName: string, reports: RunReport[], dir?: string): string {
  const s = summarize(reports);
  const ordered = clusterByBase(reports);
  let prevBase = "";
  const rows = ordered
    .map((r) => {
      const v = r.verdict;
      const color =
        v.decision === "pass" ? "#16a34a" : v.decision === "fail" ? "#dc2626" : "#d97706";
      // Link to the individual report + interactive trace (+ video), relative to the suite dir.
      const link =
        dir && r.runDir
          ? `<a href="${esc(path.relative(dir, path.join(r.runDir, "report.html")))}">report</a> · ` +
            `<a href="${esc(path.relative(dir, path.join(r.runDir, "trace.html")))}">trace</a>` +
            (r.videoPath
              ? ` · <a href="${esc(path.relative(dir, path.join(r.runDir, r.videoPath)))}">video</a>`
              : "")
          : "";
      const flaky = r.flaky ? ' <span class="flaky">flaky</span>' : "";
      // Per-run QA-dimension badges.
      const qa = [
        r.a11y?.violations.length ? `<span class="qa a11y" title="accessibility violations">♿ ${r.a11y.violations.length}</span>` : "",
        r.perfBudgetViolations?.length ? `<span class="qa perf" title="perf budget exceeded">⚡</span>` : "",
        hasVisualDiff(r) ? `<span class="qa vis" title="visual diff">🖼</span>` : "",
      ].join("");
      // Show the base name once per group; variants get a small label.
      const { base, variant } = parseVariant(r.spec.title);
      const sameGroup = variant && base === prevBase;
      prevBase = base;
      const nameCell = variant
        ? `${sameGroup ? '<span class="cont">↳</span>' : esc(base)} <span class="variant">${esc(variant)}</span>`
        : esc(r.spec.title);
      const t = runTriage(r);
      const triageCell =
        t.category === "passed"
          ? ""
          : `<span class="cat" title="${esc(t.reason)}">${CATEGORY_META[t.category].emoji} ${esc(CATEGORY_META[t.category].label)}</span>`;
      return `<tr${variant ? ' class="variant-row"' : ""}>
        <td><span class="dot" style="background:${color}"></span>${esc(v.decision)}${flaky}</td>
        <td>${nameCell} ${qa}</td>
        <td>${triageCell}</td>
        <td>${(v.confidence * 100).toFixed(0)}%</td>
        <td>${r.steps.length}</td>
        <td>${(r.durationMs / 1000).toFixed(1)}s</td>
        <td class="sum">${esc(v.summary)}</td>
        <td>${link}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel suite — ${esc(suiteName)}</title>
<style>
  body{font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:#0b0e14;color:#e6e6e6}
  .wrap{max-width:1100px;margin:0 auto;padding:32px 24px 80px}
  h1{font-size:24px;margin:.2em 0}
  .stats{color:#9aa4b2;margin:8px 0 20px;font-size:14px}
  .stats b{color:#e6e6e6}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:9px 10px;border-bottom:1px solid #1a2130;text-align:left;vertical-align:top}
  th{color:#9aa4b2;font-weight:600}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px}
  .sum{color:#9aa4b2;max-width:420px}
  .flaky{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:#7c5e10;color:#fde68a;font-size:11px}
  .qa{display:inline-block;margin-left:5px;padding:1px 6px;border-radius:4px;font-size:11px}
  .qa.a11y{background:#3b1d5e;color:#e9d5ff} .qa.perf{background:#5e3b1d;color:#fed7aa} .qa.vis{background:#1d3b5e;color:#bae6fd}
  .variant{display:inline-block;padding:1px 6px;border-radius:4px;background:#1a2130;color:#9aa4b2;font-size:11px}
  .cat{display:inline-block;white-space:nowrap;font-size:12px;color:#cbd5e1}
  .cont{color:#566;margin-right:4px}
  tr.variant-row td:nth-child(2){padding-left:18px}
  a{color:#7dd3fc}
</style></head><body><div class="wrap">
  <h1>${esc(suiteName)}</h1>
  <div class="stats"><b>${s.pass}/${s.total}</b> passed ·
    <span style="color:#16a34a">${s.pass} pass</span> ·
    <span style="color:#dc2626">${s.fail} fail</span> ·
    <span style="color:#d97706">${s.inconclusive} inconclusive</span> ·
    ${s.flaky ? `<span style="color:#fde68a">${s.flaky} flaky</span> · ` : ""}${(s.durationMs / 1000).toFixed(1)}s total ·
    ${esc(formatUsage(sumUsage(reports.map((r) => r.usage))))}</div>
  ${s.actionable ? `<div class="stats">Triage (${s.actionable} need attention): ${esc(triageRollup(s))}</div>` : ""}
  ${
    s.a11yViolations || s.perfBreaches || s.visualDiffs || s.securityIssues || s.runtimeErrors || s.failedAssertions || s.layoutIssues
      ? `<div class="stats">QA: ${[
          s.a11yViolations ? `<span style="color:#e9d5ff">♿ ${s.a11yViolations} a11y violation(s)</span>` : "",
          s.perfBreaches ? `<span style="color:#fed7aa">⚡ ${s.perfBreaches} perf breach(es)</span>` : "",
          s.visualDiffs ? `<span style="color:#bae6fd">🖼 ${s.visualDiffs} visual diff(s)</span>` : "",
          s.layoutIssues ? `<span style="color:#fbcfe8">📐 ${s.layoutIssues} layout</span>` : "",
          s.securityIssues ? `<span style="color:#fecaca">🔒 ${s.securityIssues} security</span>` : "",
          s.runtimeErrors ? `<span style="color:#fca5a5">💥 ${s.runtimeErrors} runtime-error(s)</span>` : "",
          s.failedAssertions ? `<span style="color:#fde68a">🚩 ${s.failedAssertions} assertion(s)</span>` : "",
        ]
          .filter(Boolean)
          .join(" · ")}</div>`
      : ""
  }
  <table><thead><tr><th>Result</th><th>Test</th><th>Triage</th><th>Conf</th><th>Steps</th><th>Time</th><th>Summary</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table>
</div></body></html>`;
}

/** Write the aggregate suite report (html + md) into `dir`. */
export function writeSuiteReport(dir: string, suiteName: string, reports: RunReport[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, "index.html");
  fs.writeFileSync(htmlPath, toSuiteHtml(suiteName, reports, dir));
  fs.writeFileSync(path.join(dir, "summary.md"), toSuiteMarkdown(suiteName, reports));
  return htmlPath;
}
