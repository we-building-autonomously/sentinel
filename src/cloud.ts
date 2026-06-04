import type { RunReport } from "./types.js";
import { toQaResult } from "./qa-result.js";

/**
 * Report a finished run to Sentinel Cloud (the control plane), if configured.
 *
 * Opt-in via two env vars — set them and every run streams its verdict to your
 * dashboard and meters against your credits:
 *   SENTINEL_CLOUD_URL   e.g. https://app.sentinel.dev
 *   SENTINEL_API_KEY     sk_sntl_…
 *
 * Network failures are swallowed (a QA run must never fail because the cloud is
 * unreachable); set SENTINEL_DEBUG=1 to see why a report was dropped. Bounded by
 * a short timeout so it can't hang the CLI.
 */
export async function reportRun(report: RunReport): Promise<void> {
  const base = process.env.SENTINEL_CLOUD_URL?.replace(/\/$/, "");
  const key = process.env.SENTINEL_API_KEY;
  if (!base || !key) return;

  const debug = (msg: string) => {
    if (process.env.SENTINEL_DEBUG) process.stderr.write(`[sentinel-cloud] ${msg}\n`);
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(toQaResult(report)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { creditBalance?: number };
      debug(`reported (${res.status}); ${body.creditBalance ?? "?"} credits left`);
    } else if (res.status === 402) {
      process.stderr.write("[sentinel-cloud] out of credits — top up to keep recording runs\n");
    } else {
      debug(`report rejected: HTTP ${res.status}`);
    }
  } catch (err) {
    debug(`report failed: ${(err as Error).message}`);
  }
}
