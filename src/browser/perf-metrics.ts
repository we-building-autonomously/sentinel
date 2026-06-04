import type { Page } from "playwright";

/** Page-load performance metrics (ms from navigation start), via the Performance API. */
export interface PerfMetrics {
  /** Time to first byte (responseStart). */
  ttfbMs: number | null;
  /** First Contentful Paint. */
  fcpMs: number | null;
  /** DOMContentLoaded event end. */
  domContentLoadedMs: number | null;
  /** load event end. */
  loadMs: number | null;
  /** Bytes transferred for the main document (if reported). */
  transferKb: number | null;
}

export interface PerfBudget {
  ttfbMs?: number;
  fcpMs?: number;
  loadMs?: number;
}

export interface PerfBudgetViolation {
  metric: keyof PerfBudget;
  actual: number;
  budget: number;
}

/* istanbul ignore next -- runs in the browser */
function readNavigationTiming(): PerfMetrics {
  const round = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const fcp = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
  return {
    ttfbMs: nav ? round(nav.responseStart) : null,
    fcpMs: fcp ? round(fcp.startTime) : null,
    domContentLoadedMs: nav ? round(nav.domContentLoadedEventEnd) : null,
    loadMs: nav && nav.loadEventEnd > 0 ? round(nav.loadEventEnd) : null,
    transferKb: nav && nav.transferSize ? round(nav.transferSize / 1024) : null,
  };
}

/** Read load-performance metrics for the current page (best-effort). */
export async function collectPerfMetrics(page: Page): Promise<PerfMetrics> {
  try {
    return await page.evaluate(readNavigationTiming);
  } catch {
    return { ttfbMs: null, fcpMs: null, domContentLoadedMs: null, loadMs: null, transferKb: null };
  }
}

/** Compare metrics against a budget. Pure/testable. Missing metrics are skipped. */
export function evaluatePerfBudget(metrics: PerfMetrics, budget: PerfBudget): PerfBudgetViolation[] {
  const out: PerfBudgetViolation[] = [];
  const check = (metric: keyof PerfBudget, actual: number | null) => {
    const limit = budget[metric];
    if (limit != null && actual != null && actual > limit) out.push({ metric, actual, budget: limit });
  };
  check("ttfbMs", metrics.ttfbMs);
  check("fcpMs", metrics.fcpMs);
  check("loadMs", metrics.loadMs);
  return out;
}

/** One-line label for reports, or "" when nothing was measured. */
export function formatPerfMetrics(m: PerfMetrics): string {
  const parts: string[] = [];
  if (m.ttfbMs != null) parts.push(`TTFB ${m.ttfbMs}ms`);
  if (m.fcpMs != null) parts.push(`FCP ${m.fcpMs}ms`);
  if (m.loadMs != null) parts.push(`load ${m.loadMs}ms`);
  if (m.transferKb != null) parts.push(`${m.transferKb}KB`);
  return parts.join(" · ");
}
