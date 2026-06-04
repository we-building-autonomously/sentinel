import type { RunReport, Step, Triage } from "./types.js";
import { detectChallenge } from "./browser/challenge.js";

/**
 * A coarse, ACTIONABLE classification of a run's outcome. The verdict says
 * pass/fail/inconclusive; triage says *what to do about it*. At suite scale —
 * 20 of 100 specs red — an engineer needs to separate "the app has a bug" from
 * "the run hit a CAPTCHA", "the staging box is down", or "we ran out of steps".
 * Each maps to a different owner and a different next action.
 */
function lastDone(steps: Step[]): { outcome?: string; notes: string } | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].call.name === "done") {
      const input = steps[i].call.input ?? {};
      return {
        outcome: typeof input.outcome === "string" ? input.outcome : undefined,
        notes: typeof input.notes === "string" ? input.notes : "",
      };
    }
  }
  return null;
}

/**
 * Classify a finished run deterministically from signals already in the report:
 * the verdict decision, the agent's closing `done` outcome/notes, whether any
 * real action was taken, the flaky flag, and any external-challenge keywords.
 * Pure and side-effect-free.
 */
export function classifyRun(report: RunReport): Triage {
  const { decision, summary, issues } = report.verdict;
  const steps = report.steps ?? [];
  const done = lastDone(steps);
  const tookAction = steps.some((s) => s.call.name !== "done");
  // External gates can be named in the agent's own notes, the verdict summary,
  // or the listed issues — scan them all.
  const challenge = detectChallenge([done?.notes ?? "", summary, ...(issues ?? [])].join("\n"));

  if (decision === "pass") {
    return report.flaky
      ? { category: "flaky-pass", reason: "Passed only after a retry — unstable.", actionable: true }
      : { category: "passed", reason: summary || "All checkpoints met.", actionable: false };
  }

  // Block signals win over the raw decision: they EXPLAIN a fail/inconclusive
  // and route it away from "product bug".
  if (challenge) {
    return {
      category: "blocked-external",
      reason: `Blocked by an external ${challenge.kind} gate — not a product defect.`,
      actionable: true,
    };
  }
  if (done?.outcome === "blocked") {
    return {
      category: "blocked",
      reason: done.notes || "The agent could not proceed (e.g. login wall or a required element never appeared).",
      actionable: true,
    };
  }

  if (decision === "inconclusive") {
    // Zero real actions + inconclusive == we never got off the ground (the
    // unreachable short-circuit, or setup failed before the agent ran).
    if (!tookAction) {
      return { category: "app-unavailable", reason: summary || "The app could not be loaded.", actionable: true };
    }
    return {
      category: "inconclusive",
      reason: summary || "Insufficient evidence to decide (e.g. ran out of steps before verifying).",
      actionable: true,
    };
  }

  // decision === "fail" with no block signal: the app did the wrong thing.
  return { category: "product-defect", reason: summary || "The app behaved incorrectly.", actionable: true };
}
