import fs from "node:fs";
import path from "node:path";
import type { RunReport, Decision, RunCategory } from "../types.js";
import { classifyRun } from "../triage.js";

export interface RunSummary {
  title: string;
  decision: Decision;
  /** Triage category, when known — lets trend ignore environment blips. */
  category?: RunCategory;
  flaky: boolean;
  /** Total QA-dimension issues in this run (a11y/perf/visual/layout/security/errors/assertions). */
  qaIssues: number;
  durationMs: number;
  costUsd: number;
  startedAt: string;
  runDir: string;
}

/** Count every QA-dimension issue in a run — for tracking quality drift over time. */
export function countQaIssues(report: RunReport): number {
  let n = 0;
  n += report.a11y?.violations.length ?? 0;
  n += report.perfBudgetViolations?.length ?? 0;
  if (report.visual?.status === "diff" || report.visual?.status === "size-mismatch") n += 1;
  if (report.layout?.horizontalOverflow) n += 1;
  n += (report.security?.counts.high ?? 0) + (report.security?.counts.medium ?? 0);
  n += (report.diagnostics ?? []).filter((d) => d.level === "error").length;
  n += (report.requestChecks ?? []).filter((c) => !c.met).length;
  n += (report.textChecks ?? []).filter((c) => !c.met).length;
  n += (report.urlChecks ?? []).filter((c) => !c.met).length;
  n += (report.stateChecks ?? []).filter((c) => !c.met).length;
  n += (report.downloadChecks ?? []).filter((c) => !c.met).length;
  if (report.clipboardCheck?.met === false) n += 1;
  if (report.toastCheck?.met === false) n += 1;
  return n;
}

export type Trend = "regressed" | "fixed" | "stable" | "new" | "blocked";

export interface SpecHistory {
  title: string;
  total: number;
  passes: number;
  passRate: number;
  flakyCount: number;
  lastDecision: Decision;
  lastRun: string;
  avgDurationMs: number;
  totalCostUsd: number;
  /** QA-dimension issues in the most recent run (quality-drift indicator). */
  lastQaIssues: number;
  /** True if the latest run has MORE QA issues than the prior run (quality drift). */
  qaDrift: boolean;
  /** Movement vs the most recent differing prior result. */
  trend: Trend;
  /** Newest-first recent results, for a sparkline. */
  recent: Array<{ decision: Decision; category?: RunCategory; startedAt: string; flaky: boolean }>;
}

type StateClass = "good" | "real-fail" | "env-block";

/**
 * Classify a run for trend purposes. With a triage category we can tell a real
 * failure (product-defect / inconclusive) apart from an environment block
 * (CAPTCHA, 2FA, app-down) — the latter must NOT count as a regression. Without
 * a category we fall back to decision-only (pass = good, else real-fail).
 */
function stateClass(rec: { decision: Decision; category?: RunCategory }): StateClass {
  const c = rec.category;
  if (!c) return rec.decision === "pass" ? "good" : "real-fail";
  if (c === "passed" || c === "flaky-pass") return "good";
  if (c === "blocked" || c === "blocked-external" || c === "app-unavailable" || c === "skipped")
    return "env-block"; // not-run / blocked is never a code regression
  return "real-fail"; // product-defect, inconclusive
}

/**
 * Movement of the latest result vs the most recent *differing* prior one.
 * Triage-aware: an environment-blocked latest run is "blocked" (needs a look
 * but is NOT a code regression), so it never trips regression alerts/gates.
 */
export function computeTrend(recent: Array<{ decision: Decision; category?: RunCategory }>): Trend {
  if (recent.length < 2) return "new";
  const lastClass = stateClass(recent[0]);
  if (lastClass === "env-block") return "blocked"; // env blip, not a regression
  const prior = recent.slice(1).find((r) => stateClass(r) !== lastClass);
  if (!prior) return "stable"; // unchanged across all runs
  const priorClass = stateClass(prior);
  if (lastClass === "good" && priorClass === "real-fail") return "fixed";
  if (lastClass === "real-fail" && priorClass === "good") return "regressed";
  return "stable";
}

export interface History {
  specs: SpecHistory[];
  totals: { runs: number; specs: number; costUsd: number; regressed: number; fixed: number; blocked: number; qaDrifted: number };
}

/** Pull the fields we trend from a full run report. */
export function summarizeRun(report: RunReport): RunSummary {
  return {
    title: report.spec.title,
    decision: report.verdict.decision,
    category: (report.triage ?? classifyRun(report)).category,
    flaky: !!report.flaky,
    qaIssues: countQaIssues(report),
    durationMs: report.durationMs,
    costUsd: report.usage?.costUsd ?? 0,
    startedAt: report.startedAt,
    runDir: report.runDir,
  };
}

/** Aggregate run summaries into per-spec history, newest activity first. */
export function buildHistory(summaries: RunSummary[]): History {
  const byTitle = new Map<string, RunSummary[]>();
  for (const s of summaries) {
    const arr = byTitle.get(s.title) ?? [];
    arr.push(s);
    byTitle.set(s.title, arr);
  }

  const specs: SpecHistory[] = [];
  let totalCost = 0;
  for (const [title, runsRaw] of byTitle) {
    // Sort newest-first by startedAt (ISO strings sort chronologically).
    const runs = [...runsRaw].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const passes = runs.filter((r) => r.decision === "pass").length;
    const cost = runs.reduce((n, r) => n + r.costUsd, 0);
    totalCost += cost;
    const recent = runs
      .slice(0, 15)
      .map((r) => ({ decision: r.decision, category: r.category, startedAt: r.startedAt, flaky: r.flaky }));
    specs.push({
      title,
      total: runs.length,
      passes,
      passRate: runs.length ? passes / runs.length : 0,
      flakyCount: runs.filter((r) => r.flaky).length,
      lastDecision: runs[0].decision,
      lastRun: runs[0].startedAt,
      lastQaIssues: runs[0].qaIssues ?? 0,
      qaDrift: runs.length > 1 && (runs[0].qaIssues ?? 0) > (runs[1].qaIssues ?? 0),
      avgDurationMs: runs.reduce((n, r) => n + r.durationMs, 0) / runs.length,
      totalCostUsd: cost,
      trend: computeTrend(recent),
      recent,
    });
  }

  // Regressions first, then most recently active.
  const rank = (t: Trend) => (t === "regressed" ? 0 : 1);
  specs.sort((a, b) => rank(a.trend) - rank(b.trend) || (a.lastRun < b.lastRun ? 1 : -1));
  return {
    specs,
    totals: {
      runs: summaries.length,
      specs: specs.length,
      costUsd: round(totalCost),
      regressed: specs.filter((s) => s.trend === "regressed").length,
      fixed: specs.filter((s) => s.trend === "fixed").length,
      blocked: specs.filter((s) => s.trend === "blocked").length,
      qaDrifted: specs.filter((s) => s.qaDrift).length,
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Read every run's report.json under `runsDir` into run summaries (best-effort). */
export function scanRuns(runsDir: string): RunSummary[] {
  if (!fs.existsSync(runsDir)) return [];
  const out: RunSummary[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(runsDir, entry.name, "report.json");
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const report = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as RunReport;
      if (report?.spec?.title && report?.verdict?.decision) out.push(summarizeRun(report));
    } catch {
      // Malformed report — skip it.
    }
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const DOT: Record<Decision, string> = { pass: "#16a34a", fail: "#dc2626", inconclusive: "#d97706" };

export function toHistoryHtml(history: History, title = "Sentinel — run history"): string {
  const rows = history.specs
    .map((s) => {
      const pct = (s.passRate * 100).toFixed(0);
      // Oldest→newest left→right sparkline.
      const spark = [...s.recent]
        .reverse()
        .map(
          (r) =>
            `<span class="sq" title="${esc(r.startedAt)}${r.flaky ? " (flaky)" : ""}" style="background:${DOT[r.decision]}${
              r.flaky ? ";outline:1px solid #fde68a" : ""
            }"></span>`
        )
        .join("");
      const lastColor = DOT[s.lastDecision];
      const trendBadge =
        s.trend === "regressed"
          ? '<span class="tr reg">▼ regressed</span>'
          : s.trend === "fixed"
            ? '<span class="tr fix">▲ fixed</span>'
            : s.trend === "blocked"
              ? '<span class="tr blk">⊘ blocked</span>'
              : s.trend === "new"
                ? '<span class="tr new">new</span>'
                : "";
      return `<tr class="${s.trend === "regressed" ? "rowreg" : ""}">
        <td><span class="dot" style="background:${lastColor}"></span>${esc(s.title)} ${trendBadge}</td>
        <td class="spark">${spark}</td>
        <td><div class="bar"><div style="width:${pct}%;background:${s.passRate >= 0.8 ? "#16a34a" : s.passRate >= 0.5 ? "#d97706" : "#dc2626"}"></div></div><span class="pct">${pct}%</span></td>
        <td>${s.passes}/${s.total}</td>
        <td>${s.flakyCount || ""}</td>
        <td>${s.lastQaIssues ? `<span class="qa${s.qaDrift ? " drift" : ""}" title="${s.qaDrift ? "QA issues INCREASED vs the prior run — " : ""}QA-dimension issues in the latest run">⚠ ${s.lastQaIssues}${s.qaDrift ? " ↑" : ""}</span>` : ""}</td>
        <td>${(s.avgDurationMs / 1000).toFixed(1)}s</td>
        <td>$${s.totalCostUsd.toFixed(4)}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:#0b0e14;color:#e6e6e6}
  .wrap{max-width:1100px;margin:0 auto;padding:32px 24px 80px}
  h1{font-size:22px;margin:.2em 0}
  .stats{color:#9aa4b2;font-size:13px;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:9px 10px;border-bottom:1px solid #1a2130;text-align:left;vertical-align:middle}
  th{color:#9aa4b2;font-weight:600}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px}
  .spark{white-space:nowrap}
  .sq{display:inline-block;width:10px;height:14px;border-radius:2px;margin-right:2px;vertical-align:middle}
  .bar{display:inline-block;width:90px;height:8px;background:#1a2130;border-radius:4px;overflow:hidden;vertical-align:middle;margin-right:6px}
  .bar>div{height:100%}
  .pct{color:#9aa4b2;font-size:12px}
  .tr{font-size:11px;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:middle}
  .tr.reg{background:#7f1d1d;color:#fecaca}
  .tr.fix{background:#14532d;color:#bbf7d0}
  .tr.new{background:#1a2130;color:#9aa4b2}
  .tr.blk{background:#422006;color:#fed7aa}
  .qa{color:#fed7aa;font-size:12px;white-space:nowrap}
  .qa.drift{color:#fca5a5;font-weight:600}
  tr.rowreg td{background:rgba(220,38,38,.08)}
  .banner{padding:10px 14px;border-radius:8px;margin-bottom:16px;font-weight:600}
  .banner.bad{background:#7f1d1d;color:#fecaca}
</style></head><body><div class="wrap">
  <h1>${esc(title)}</h1>
  ${history.totals.regressed ? `<div class="banner bad">⚠ ${history.totals.regressed} spec(s) regressed since their previous run</div>` : ""}
  ${history.totals.qaDrifted ? `<div class="banner bad">⚠ ${history.totals.qaDrifted} spec(s) gained QA-dimension issues vs their previous run</div>` : ""}
  <div class="stats"><b>${history.totals.specs}</b> specs · <b>${history.totals.runs}</b> runs${history.totals.regressed ? ` · <span style="color:#fecaca">${history.totals.regressed} regressed</span>` : ""}${history.totals.fixed ? ` · <span style="color:#bbf7d0">${history.totals.fixed} fixed</span>` : ""} · ~$${history.totals.costUsd.toFixed(4)} total</div>
  <table><thead><tr><th>Spec</th><th>Recent</th><th>Pass rate</th><th>P/Total</th><th>Flaky</th><th>QA</th><th>Avg</th><th>Cost</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" style="color:#9aa4b2">No runs found.</td></tr>'}</tbody></table>
</div></body></html>`;
}

/** Scan a runs dir and write the trend dashboard to `out`. Returns the history. */
export function writeHistory(runsDir: string, out: string): { path: string; history: History } {
  const history = buildHistory(scanRuns(runsDir));
  fs.writeFileSync(out, toHistoryHtml(history));
  return { path: out, history };
}
