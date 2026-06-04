// Verifies `sentinel history --fail-on-regression` exits non-zero only when a
// spec regressed. Notify is covered by unit tests (notifyRegression).
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFile } from "node:child_process"; import { promisify } from "node:util";
const run = promisify(execFile);
const cli = path.resolve(new URL(".", import.meta.url).pathname, "../dist/cli.js");
function mk(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-gate-"));
  specs.forEach(([name, title, decision, when], i) => {
    const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "report.json"), JSON.stringify({
      spec:{title,task:"x",intent:"y",app:{url:"https://e.com"}}, plan:{goal:"g",checkpoints:[]}, steps:[],
      verdict:{decision,confidence:1,summary:"s",checkpoints:[],issues:[]},
      startedAt:when, finishedAt:when, durationMs:2000, runDir:d }));
  });
  return dir;
}
async function exit(dir, gate) {
  const args = ["history","--dir",dir,"--out",path.join(dir,"i.html")];
  if (gate) args.push("--fail-on-regression");
  try { await run("node",[cli,...args]); return 0; } catch (e) { return e.code; }
}
const regressed = mk([["a","Checkout","pass","2026-06-01T00:00:00Z"],["b","Checkout","fail","2026-06-03T00:00:00Z"]]);
const clean = mk([["a","Checkout","pass","2026-06-01T00:00:00Z"]]);
const a = await exit(regressed, true), b = await exit(regressed, false), c = await exit(clean, true);
console.log(`gate+regression=${a} (1)  no-gate+regression=${b} (0)  gate+clean=${c} (0)`);
const ok = a===1 && b===0 && c===0;
console.log(ok ? "OK — regression CI gate exit codes correct." : "FAIL");
process.exit(ok?0:1);
