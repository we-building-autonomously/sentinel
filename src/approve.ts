import fs from "node:fs";
import path from "node:path";
import type { RunReport } from "./types.js";

export interface PendingApproval {
  title: string;
  runDir: string;
  baselinePath: string;
  currentPath: string;
  diffRatio: number;
}

/** Read a run's report.json, tolerating missing/malformed files. */
function readReport(runDir: string): RunReport | null {
  const p = path.join(runDir, "report.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as RunReport;
  } catch {
    return null;
  }
}

/** Is this run a visual regression with a captured current screenshot to promote? */
function approvalFor(runDir: string): PendingApproval | null {
  const report = readReport(runDir);
  const v = report?.visual;
  if (!v || (v.status !== "diff" && v.status !== "size-mismatch")) return null;
  const currentPath = path.join(runDir, "visual-current.png");
  if (!v.baselinePath || !fs.existsSync(currentPath)) return null;
  return {
    title: report!.spec.title,
    runDir,
    baselinePath: v.baselinePath,
    currentPath,
    diffRatio: v.diffRatio,
  };
}

/** All runs under `runsDir` whose visual screenshot can be promoted to baseline. */
export function findApprovals(runsDir: string): PendingApproval[] {
  if (!fs.existsSync(runsDir)) return [];
  const out: PendingApproval[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const a = approvalFor(path.join(runsDir, entry.name));
    if (a) out.push(a);
  }
  return out;
}

/** Promote a single run's current screenshot to its baseline. Returns the move, or null. */
export function approveRun(runDir: string): { from: string; to: string; title: string } | null {
  const a = approvalFor(runDir);
  if (!a) return null;
  fs.mkdirSync(path.dirname(a.baselinePath), { recursive: true });
  fs.copyFileSync(a.currentPath, a.baselinePath);
  return { from: a.currentPath, to: a.baselinePath, title: a.title };
}
