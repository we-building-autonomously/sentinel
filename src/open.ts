import fs from "node:fs";
import path from "node:path";

/** Find the most recently written report (suite index.html or a run report.html). */
export function findLatestReport(runsDir: string): string | null {
  if (!fs.existsSync(runsDir)) return null;
  let best: string | null = null;
  let bestTime = -1;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ["index.html", "report.html"]) {
      const p = path.join(runsDir, entry.name, name);
      if (!fs.existsSync(p)) continue;
      const t = fs.statSync(p).mtimeMs;
      if (t > bestTime) {
        bestTime = t;
        best = p;
      }
    }
  }
  return best;
}

/** The OS command that opens a file in the default app. */
export function openerFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "start";
  return "xdg-open";
}
