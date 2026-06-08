import type { Verdict } from "../types.js";

export interface ReconcileContext {
  /**
   * Human labels of author-declared DETERMINISTIC assertions that came back
   * UNMET (expectText/expectUrl/expectState/expectRequests/expectDownloads/
   * clipboard/toast). These are objective acceptance criteria the author pinned;
   * an unmet one is incompatible with a "pass" no matter what the judge decided.
   */
  unmetAssertions?: string[];
}

/**
 * Enforce internal consistency between the judge's headline decision and the
 * objective evidence. The acceptance criteria for a run are (a) the plan
 * checkpoints and (b) any deterministic assertions the author declared — ALL
 * must hold to pass. An LLM judge can still return a "pass" while leaving a
 * checkpoint `unmet`/`unknown` or while a hard assertion failed: a
 * self-contradicting green that is the single most dangerous output a QA
 * harness can emit (a falsely-passing test hides the very bug it exists to find).
 *
 * Pure, conservative reconciliation applied AFTER the judge returns:
 *   - pass + any checkpoint `unmet`             -> fail          (objective contradiction)
 *   - pass + any deterministic assertion unmet  -> fail          (objective contradiction)
 *   - pass + any checkpoint `unknown`           -> inconclusive  (success not observed)
 *   - pass + everything coherent                -> unchanged
 *
 * It only ever TIGHTENS a pass — never upgrades a fail/inconclusive. Every
 * override is transparent: the original decision is recorded as an issue and the
 * confidence is capped to signal the verdict was machine-corrected.
 */
export function reconcileVerdict(verdict: Verdict, ctx: ReconcileContext = {}): Verdict {
  if (verdict.decision !== "pass") return verdict;

  const unmetAssertions = ctx.unmetAssertions ?? [];
  const unmet = verdict.checkpoints.filter((c) => c.status === "unmet");
  // A checkpoint reported "met" but with no observable evidence ("none") was
  // not actually confirmed — treat it as unconfirmed, not a basis for a pass.
  // This is the calibration backstop: a confident-but-baseless green is exactly
  // the verdict a QA harness must never emit.
  const unconfirmed = verdict.checkpoints.filter(
    (c) => c.status === "unknown" || (c.status === "met" && c.evidenceStrength === "none")
  );

  if (!unmet.length && !unconfirmed.length && !unmetAssertions.length) return verdict; // coherent pass

  const ids = (cs: typeof verdict.checkpoints) => cs.map((c) => c.id).join(", ");
  let decision: Verdict["decision"];
  let note: string;
  if (unmet.length || unmetAssertions.length) {
    decision = "fail";
    const parts: string[] = [];
    if (unmet.length) parts.push(`left checkpoint(s) ${ids(unmet)} unmet`);
    if (unmetAssertions.length)
      parts.push(`${unmetAssertions.length} deterministic assertion(s) failed (${unmetAssertions.join("; ")})`);
    note =
      `Verdict reconciled pass→fail: the judge reported "pass" but ${parts.join(" and ")}. ` +
      `These are objective acceptance criteria — an unmet one cannot be a pass.`;
  } else {
    decision = "inconclusive";
    note =
      `Verdict reconciled pass→inconclusive: the judge reported "pass" but ` +
      `checkpoint(s) ${ids(unconfirmed)} could not be confirmed (status unknown or marked "met" with no observable evidence). ` +
      `Success was not observably established.`;
  }

  return {
    ...verdict,
    decision,
    // The verdict contradicted itself, so neither the original pass nor a
    // fully-confident flip is warranted — cap to signal "auto-reconciled".
    confidence: Math.min(verdict.confidence, 0.5),
    issues: [note, ...verdict.issues],
  };
}
