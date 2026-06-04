import { createRequire } from "node:module";
import type { Page } from "playwright";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

export type A11yImpact = "critical" | "serious" | "moderate" | "minor";

export interface A11yViolation {
  id: string;
  impact: A11yImpact;
  help: string;
  /** Number of DOM nodes affected. */
  nodes: number;
  /** CSS selectors of the affected elements (capped), so the fix is targetable. */
  selectors: string[];
}

/** Max selectors surfaced per violation. */
const MAX_SELECTORS = 5;

export interface A11yResult {
  violations: A11yViolation[];
  counts: Record<A11yImpact, number>;
  /** Total affected nodes across all violations. */
  total: number;
}

const ORDER: Record<A11yImpact, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

/** Shape of the bits of an axe result we consume (kept loose for the raw input). */
interface RawAxe {
  violations?: Array<{
    id: string;
    impact?: string | null;
    help?: string;
    nodes?: Array<{ target?: unknown }>;
  }>;
}

/** Pull a flat list of CSS selectors from axe node targets (each target is a path array). */
function selectorsOf(nodes: Array<{ target?: unknown }> | undefined): string[] {
  const out: string[] = [];
  for (const n of nodes ?? []) {
    const target = n?.target;
    const sel = Array.isArray(target) ? target.find((t) => typeof t === "string") : undefined;
    if (typeof sel === "string") out.push(sel);
    if (out.length >= MAX_SELECTORS) break;
  }
  return out;
}

/** Reduce a raw axe.run() result into a sorted, counted summary. Pure/testable. */
export function summarizeAxe(raw: RawAxe): A11yResult {
  const counts: Record<A11yImpact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const violations: A11yViolation[] = (raw.violations ?? []).map((v) => {
    const impact = (["critical", "serious", "moderate", "minor"].includes(v.impact ?? "")
      ? v.impact
      : "minor") as A11yImpact;
    counts[impact]++;
    return {
      id: v.id,
      impact,
      help: v.help ?? v.id,
      nodes: Array.isArray(v.nodes) ? v.nodes.length : 0,
      selectors: selectorsOf(v.nodes),
    };
  });
  violations.sort((a, b) => ORDER[a.impact] - ORDER[b.impact]);
  return {
    violations,
    counts,
    total: violations.reduce((n, v) => n + v.nodes, 0),
  };
}

/**
 * Inject axe-core into the page and run an accessibility audit on the current
 * DOM. Returns a summarized result (violations only). Best-effort — returns an
 * empty result if axe can't run (e.g. a restricted page).
 */
export async function runA11y(page: Page): Promise<A11yResult> {
  try {
    await page.addScriptTag({ path: AXE_PATH });
    const raw = (await page.evaluate(async () => {
      // axe is attached to window by the injected script.
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }).axe;
      return await axe.run(document, { resultTypes: ["violations"] });
    })) as RawAxe;
    return summarizeAxe(raw);
  } catch {
    return summarizeAxe({ violations: [] });
  }
}

/** One-line label for reports, or "" when clean. */
export function formatA11y(r: A11yResult): string {
  if (!r.violations.length) return "no violations";
  const parts = (["critical", "serious", "moderate", "minor"] as A11yImpact[])
    .filter((k) => r.counts[k] > 0)
    .map((k) => `${r.counts[k]} ${k}`);
  return `${r.violations.length} violation(s): ${parts.join(", ")}`;
}
