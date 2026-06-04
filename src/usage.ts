/**
 * Token + cost accounting. A single UsageMeter is shared across every LLM call
 * in a run (planner, agent loop, extract sub-calls, judge) so the report shows
 * exactly what the test cost.
 */

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}

export interface UsageTotals {
  byModel: Record<string, ModelUsage>;
  total: ModelUsage;
  costUsd: number;
}

/** USD per *million* tokens. Cache write ≈ 1.25× input, cache read ≈ 0.1× input. */
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICING: Record<string, Price> = {
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** Match a concrete model id (e.g. "claude-opus-4-8[1m]") to a price tier. */
export function priceFor(model: string): Price {
  const m = model.toLowerCase();
  if (m.includes("opus")) return PRICING["claude-opus-4"];
  if (m.includes("haiku")) return PRICING["claude-haiku-4"];
  // Sonnet is the sensible default for unknown/other models.
  return PRICING["claude-sonnet-4"];
}

function empty(): ModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
}

export class UsageMeter {
  private byModel = new Map<string, ModelUsage>();

  record(
    model: string,
    u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  ): void {
    const cur = this.byModel.get(model) ?? empty();
    cur.input += u.input ?? 0;
    cur.output += u.output ?? 0;
    cur.cacheRead += u.cacheRead ?? 0;
    cur.cacheWrite += u.cacheWrite ?? 0;
    cur.calls += 1;
    this.byModel.set(model, cur);
  }

  totals(): UsageTotals {
    const total = empty();
    let costUsd = 0;
    const byModel: Record<string, ModelUsage> = {};
    for (const [model, u] of this.byModel) {
      byModel[model] = u;
      total.input += u.input;
      total.output += u.output;
      total.cacheRead += u.cacheRead;
      total.cacheWrite += u.cacheWrite;
      total.calls += u.calls;
      const p = priceFor(model);
      costUsd +=
        (u.input * p.input +
          u.output * p.output +
          u.cacheRead * p.cacheRead +
          u.cacheWrite * p.cacheWrite) /
        1_000_000;
    }
    return { byModel, total, costUsd: round(costUsd) };
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Sum already-computed run totals (for suite-level reporting). */
export function sumUsage(totals: (UsageTotals | undefined)[]): UsageTotals {
  const total: ModelUsage = empty();
  const byModel: Record<string, ModelUsage> = {};
  let costUsd = 0;
  for (const t of totals) {
    if (!t) continue;
    costUsd += t.costUsd;
    total.input += t.total.input;
    total.output += t.total.output;
    total.cacheRead += t.total.cacheRead;
    total.cacheWrite += t.total.cacheWrite;
    total.calls += t.total.calls;
    for (const [m, u] of Object.entries(t.byModel)) {
      const cur = byModel[m] ?? empty();
      cur.input += u.input;
      cur.output += u.output;
      cur.cacheRead += u.cacheRead;
      cur.cacheWrite += u.cacheWrite;
      cur.calls += u.calls;
      byModel[m] = cur;
    }
  }
  return { byModel, total, costUsd: round(costUsd) };
}

/** Compact human label, e.g. "12.3k in / 4.1k out · ~$0.05". */
export function formatUsage(t: UsageTotals): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const cached = t.total.cacheRead ? `, ${k(t.total.cacheRead)} cached` : "";
  return `${k(t.total.input)} in / ${k(t.total.output)} out${cached} · ~$${t.costUsd.toFixed(4)}`;
}
