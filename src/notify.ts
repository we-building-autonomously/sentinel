import type { RunReport } from "./types.js";
import { summarize, triageRollup, runTriage } from "./report/suite-report.js";
import { sumUsage } from "./usage.js";

export interface SuitePayload {
  suite: string;
  ok: boolean;
  summary: { total: number; pass: number; fail: number; inconclusive: number; flaky: number };
  costUsd: number;
  durationMs: number;
  results: Array<{
    title: string;
    decision: RunReport["verdict"]["decision"];
    confidence: number;
    flaky: boolean;
    durationMs: number;
    summary: string;
  }>;
  timestamp?: string;
}

/** Pure structured payload for a generic JSON webhook. */
export function buildSuitePayload(
  suiteName: string,
  reports: RunReport[],
  timestamp?: string
): SuitePayload {
  const s = summarize(reports);
  const usage = sumUsage(reports.map((r) => r.usage));
  return {
    suite: suiteName,
    ok: s.fail === 0 && s.inconclusive === 0,
    summary: { total: s.total, pass: s.pass, fail: s.fail, inconclusive: s.inconclusive, flaky: s.flaky },
    costUsd: usage.costUsd,
    durationMs: s.durationMs,
    results: reports.map((r) => ({
      title: r.spec.title,
      decision: r.verdict.decision,
      confidence: r.verdict.confidence,
      flaky: !!r.flaky,
      durationMs: r.durationMs,
      summary: r.verdict.summary,
    })),
    ...(timestamp ? { timestamp } : {}),
  };
}

const EMOJI: Record<RunReport["verdict"]["decision"], string> = {
  pass: ":large_green_circle:",
  fail: ":red_circle:",
  inconclusive: ":large_yellow_circle:",
};

/** Pure Slack Block Kit message. Highlights failures/flaky; clean runs stay terse. */
export function buildSlackMessage(suiteName: string, reports: RunReport[]): { blocks: unknown[]; text: string } {
  const s = summarize(reports);
  const usage = sumUsage(reports.map((r) => r.usage));
  const headline = s.fail > 0 ? ":red_circle:" : s.inconclusive > 0 ? ":large_yellow_circle:" : ":large_green_circle:";
  const text = `${headline} ${suiteName}: ${s.pass}/${s.total} passed`;

  const context =
    `*${s.pass}* pass · *${s.fail}* fail · *${s.inconclusive}* inconclusive` +
    (s.flaky ? ` · *${s.flaky}* flaky` : "") +
    ` · ${(s.durationMs / 1000).toFixed(1)}s · ~$${usage.costUsd.toFixed(4)}`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `${headline === ":red_circle:" ? "❌" : headline === ":large_yellow_circle:" ? "⚠️" : "✅"} ${suiteName}`.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text: context } },
  ];

  // A triage rollup tells on-call where to look before they open anything.
  if (s.actionable) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Triage: ${triageRollup(s)}` }],
    });
  }

  // QA-dimension rollup (a11y/perf/visual/security/runtime/assertions).
  const qa = [
    s.a11yViolations ? `♿ ${s.a11yViolations} a11y` : "",
    s.perfBreaches ? `⚡ ${s.perfBreaches} perf` : "",
    s.visualDiffs ? `🖼 ${s.visualDiffs} visual` : "",
    s.layoutIssues ? `📐 ${s.layoutIssues} layout` : "",
    s.securityIssues ? `🔒 ${s.securityIssues} security` : "",
    s.runtimeErrors ? `💥 ${s.runtimeErrors} runtime-error` : "",
    s.failedAssertions ? `🚩 ${s.failedAssertions} assertion` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (qa) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `QA: ${qa}` }] });

  // Only surface the non-passing specs (a green run shouldn't be noisy), each
  // tagged with its triage category so the reader can route it immediately.
  const notable = reports.filter((r) => r.verdict.decision !== "pass" || r.flaky);
  if (notable.length) {
    const lines = notable
      .slice(0, 20)
      .map(
        (r) =>
          `${EMOJI[r.verdict.decision]} *${r.spec.title}*${r.flaky ? " _(flaky)_" : ""} \`${runTriage(r).category}\` — ${truncate(r.verdict.summary, 160)}`
      )
      .join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: lines } });
  }
  return { blocks, text };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** A compact alert listing regressed specs, for a webhook or Slack. */
export function buildRegressionMessage(
  regressed: Array<{ title: string }>,
  isSlack: boolean
): string {
  const titles = regressed.map((r) => r.title);
  if (isSlack) {
    return JSON.stringify({
      text: `:red_circle: ${regressed.length} spec(s) regressed`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: `❌ ${regressed.length} regression(s)` } },
        {
          type: "section",
          text: { type: "mrkdwn", text: titles.map((t) => `• *${t}*`).join("\n") || "—" },
        },
      ],
    });
  }
  return JSON.stringify({ event: "regression", count: regressed.length, specs: titles });
}

/** Post a regression alert to a webhook (Slack body for slack URLs). No-op if none. */
export async function notifyRegression(
  url: string,
  regressed: Array<{ title: string }>,
  opts: { fetchImpl?: FetchLike } = {}
): Promise<NotifyResult> {
  if (!regressed.length) return { sent: false };
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildRegressionMessage(regressed, isSlackUrl(url)),
    });
    return res.ok ? { sent: true, status: res.status } : { sent: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

/** Detect a Slack incoming-webhook URL so we can pick the right body shape. */
export function isSlackUrl(url: string): boolean {
  return /hooks\.slack\.com/i.test(url);
}

export interface NotifyResult {
  sent: boolean;
  status?: number;
  error?: string;
}

/**
 * Post a suite result to a webhook. Slack URLs get a Block Kit body; any other
 * URL gets the structured JSON payload. `fetchImpl` is injectable for testing.
 */
export async function notifySuite(
  url: string,
  suiteName: string,
  reports: RunReport[],
  opts: { fetchImpl?: FetchLike; timestamp?: string } = {}
): Promise<NotifyResult> {
  const doFetch = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const body = isSlackUrl(url)
    ? JSON.stringify(buildSlackMessage(suiteName, reports))
    : JSON.stringify(buildSuitePayload(suiteName, reports, opts.timestamp));
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return res.ok ? { sent: true, status: res.status } : { sent: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
