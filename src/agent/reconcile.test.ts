import { describe, it, expect } from "vitest";
import { reconcileVerdict } from "./reconcile.js";
import type { Verdict, Checkpoint } from "../types.js";

function cp(id: number, status: Checkpoint["status"]): Checkpoint {
  return { id, description: `cp${id}`, status, evidence: "e" };
}
function verdict(p: Partial<Verdict> & Pick<Verdict, "decision" | "checkpoints">): Verdict {
  return { confidence: 0.9, summary: "s", issues: [], ...p };
}

describe("reconcileVerdict", () => {
  it("leaves a coherent pass (all checkpoints met) untouched", () => {
    const v = verdict({ decision: "pass", checkpoints: [cp(1, "met"), cp(2, "met")] });
    expect(reconcileVerdict(v)).toEqual(v);
  });

  it("downgrades pass -> fail when a checkpoint is unmet", () => {
    const out = reconcileVerdict(
      verdict({ decision: "pass", confidence: 0.95, checkpoints: [cp(1, "met"), cp(2, "unmet")] })
    );
    expect(out.decision).toBe("fail");
    expect(out.confidence).toBeLessThanOrEqual(0.5);
    expect(out.issues[0]).toMatch(/reconciled pass→fail/);
    expect(out.issues[0]).toContain("2"); // names the offending checkpoint id
  });

  it("downgrades pass -> inconclusive when a checkpoint is unknown (none unmet)", () => {
    const out = reconcileVerdict(
      verdict({ decision: "pass", checkpoints: [cp(1, "met"), cp(2, "unknown")] })
    );
    expect(out.decision).toBe("inconclusive");
    expect(out.issues[0]).toMatch(/reconciled pass→inconclusive/);
  });

  it("prefers fail over inconclusive when both unmet and unknown are present", () => {
    const out = reconcileVerdict(
      verdict({ decision: "pass", checkpoints: [cp(1, "unknown"), cp(2, "unmet")] })
    );
    expect(out.decision).toBe("fail");
  });

  it("preserves the judge's existing issues, prepending the reconciliation note", () => {
    const out = reconcileVerdict(
      verdict({ decision: "pass", checkpoints: [cp(1, "unmet")], issues: ["pre-existing"] })
    );
    expect(out.issues).toHaveLength(2);
    expect(out.issues[1]).toBe("pre-existing");
  });

  it("never upgrades a fail, even if all checkpoints are met", () => {
    const v = verdict({ decision: "fail", checkpoints: [cp(1, "met")] });
    expect(reconcileVerdict(v)).toEqual(v);
  });

  it("does not touch a pass that has no checkpoints to contradict", () => {
    const v = verdict({ decision: "pass", checkpoints: [], confidence: 0.8 });
    expect(reconcileVerdict(v)).toEqual(v);
  });

  it("does not lower confidence on a coherent pass", () => {
    const out = reconcileVerdict(verdict({ decision: "pass", confidence: 0.4, checkpoints: [cp(1, "met")] }));
    expect(out.confidence).toBe(0.4);
  });

  it("downgrades pass -> fail when a deterministic assertion is unmet (even if all checkpoints met)", () => {
    const out = reconcileVerdict(
      verdict({ decision: "pass", confidence: 0.95, checkpoints: [cp(1, "met")] }),
      { unmetAssertions: ['expected text "Order confirmed" — NOT found'] }
    );
    expect(out.decision).toBe("fail");
    expect(out.confidence).toBeLessThanOrEqual(0.5);
    expect(out.issues[0]).toMatch(/reconciled pass→fail/);
    expect(out.issues[0]).toContain("Order confirmed");
    expect(out.issues[0]).toMatch(/deterministic assertion/);
  });

  it("flips a checkpoint-less pass to fail on an unmet assertion (no checkpoints to rely on)", () => {
    const out = reconcileVerdict(verdict({ decision: "pass", checkpoints: [] }), {
      unmetAssertions: ['URL must not contain "/login"'],
    });
    expect(out.decision).toBe("fail");
  });

  it("notes BOTH an unmet checkpoint and an unmet assertion when both fail", () => {
    const out = reconcileVerdict(verdict({ decision: "pass", checkpoints: [cp(1, "unmet")] }), {
      unmetAssertions: ["clipboard did not contain X"],
    });
    expect(out.decision).toBe("fail");
    expect(out.issues[0]).toMatch(/checkpoint\(s\) 1 unmet/);
    expect(out.issues[0]).toMatch(/deterministic assertion/);
  });

  it("leaves a coherent pass untouched when all assertions are met (empty list)", () => {
    const v = verdict({ decision: "pass", checkpoints: [cp(1, "met")] });
    expect(reconcileVerdict(v, { unmetAssertions: [] })).toEqual(v);
  });

  it("an unmet assertion does not override a fail/inconclusive (only ever tightens a pass)", () => {
    const f = verdict({ decision: "inconclusive", checkpoints: [] });
    expect(reconcileVerdict(f, { unmetAssertions: ["x unmet"] })).toEqual(f);
  });

  it("downgrades a pass whose checkpoint is 'met' with NO observable evidence to inconclusive", () => {
    const v = verdict({
      decision: "pass",
      checkpoints: [{ id: 1, description: "cp1", status: "met", evidence: "claimed", evidenceStrength: "none" }],
    });
    const out = reconcileVerdict(v);
    expect(out.decision).toBe("inconclusive");
    expect(out.confidence).toBeLessThanOrEqual(0.5);
    expect(out.issues[0]).toMatch(/no observable evidence/);
  });

  it("leaves a pass backed by strong (or weak) evidence alone", () => {
    const strong = verdict({
      decision: "pass",
      checkpoints: [{ id: 1, description: "cp1", status: "met", evidence: "seen", evidenceStrength: "strong" }],
    });
    expect(reconcileVerdict(strong)).toEqual(strong);
    const weak = verdict({
      decision: "pass",
      checkpoints: [{ id: 1, description: "cp1", status: "met", evidence: "inferred", evidenceStrength: "weak" }],
    });
    expect(reconcileVerdict(weak)).toEqual(weak);
  });
});
