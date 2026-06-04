import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findApprovals, approveRun } from "./approve.js";

let root: string;
let runsDir: string;
let baselinesDir: string;

function makeRun(name: string, title: string, visual: unknown, withCurrent: boolean): string {
  const dir = path.join(runsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "report.json"),
    JSON.stringify({
      spec: { title, task: "x", intent: "y", app: { url: "https://e.com" } },
      plan: { goal: "g", checkpoints: [] },
      steps: [],
      verdict: { decision: "pass", confidence: 1, summary: "", checkpoints: [], issues: [] },
      visual,
      startedAt: "", finishedAt: "", durationMs: 1, runDir: dir,
    })
  );
  if (withCurrent) fs.writeFileSync(path.join(dir, "visual-current.png"), "NEW-IMAGE-BYTES");
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-approve-"));
  runsDir = path.join(root, "runs");
  baselinesDir = path.join(root, "baselines");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(baselinesDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("findApprovals", () => {
  it("lists only runs with a promotable visual diff", () => {
    const bp = path.join(baselinesDir, "checkout.png");
    makeRun("a", "Checkout", { status: "diff", diffRatio: 0.06, baselinePath: bp }, true);
    makeRun("b", "Login", { status: "match", diffRatio: 0, baselinePath: bp }, false); // not a diff
    makeRun("c", "Search", { status: "diff", diffRatio: 0.1, baselinePath: bp }, false); // diff but no current png
    makeRun("d", "Home", undefined, false); // no visual at all
    const pending = findApprovals(runsDir);
    expect(pending.map((p) => p.title)).toEqual(["Checkout"]);
    expect(pending[0].diffRatio).toBeCloseTo(0.06);
  });

  it("includes size-mismatch regressions", () => {
    makeRun("a", "Sized", { status: "size-mismatch", diffRatio: 1, baselinePath: path.join(baselinesDir, "s.png") }, true);
    expect(findApprovals(runsDir)).toHaveLength(1);
  });

  it("returns empty for a missing runs dir", () => {
    expect(findApprovals(path.join(root, "nope"))).toEqual([]);
  });
});

describe("approveRun", () => {
  it("copies the current screenshot over the baseline", () => {
    const bp = path.join(baselinesDir, "checkout.png");
    fs.writeFileSync(bp, "OLD-BASELINE");
    const dir = makeRun("a", "Checkout", { status: "diff", diffRatio: 0.06, baselinePath: bp }, true);
    const res = approveRun(dir);
    expect(res).toMatchObject({ title: "Checkout", to: bp });
    expect(fs.readFileSync(bp, "utf8")).toBe("NEW-IMAGE-BYTES"); // baseline replaced
  });

  it("creates the baseline directory if it doesn't exist", () => {
    const bp = path.join(root, "fresh", "nested", "x.png");
    const dir = makeRun("a", "Fresh", { status: "diff", diffRatio: 0.06, baselinePath: bp }, true);
    expect(approveRun(dir)).not.toBeNull();
    expect(fs.existsSync(bp)).toBe(true);
  });

  it("returns null for a non-diff run", () => {
    const dir = makeRun("a", "Clean", { status: "match", diffRatio: 0, baselinePath: "x.png" }, false);
    expect(approveRun(dir)).toBeNull();
  });
});
