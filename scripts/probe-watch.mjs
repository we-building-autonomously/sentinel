import { watchAndRun, fileChangeSource } from "../dist/watch.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(),"sn-watch-")), "spec.yaml");
fs.writeFileSync(file, "title: v1\n");
await new Promise(r=>setTimeout(r,300)); // let creation events drain
let runs = 0;
const handle = watchAndRun({
  source: fileChangeSource([file]), debounceMs: 150,
  run: async () => { runs++; },
});
await new Promise(r=>setTimeout(r,400)); // initial run + any startup noise settles
const before = runs;
console.log("baseline runs after start:", before, "(>=1, runs on start)");
// Rapid burst of 4 edits -> must debounce to exactly ONE additional run.
for (const v of ["v2","v3","v4","v5"]) fs.writeFileSync(file, `title: ${v}\n`);
await new Promise(r=>setTimeout(r,500));
const afterBurst = runs - before;
console.log("runs added by a 4-edit burst:", afterBurst, "(must be 1 = debounced)");
handle.stop();
// After stop, further edits must NOT trigger runs.
const atStop = runs;
fs.writeFileSync(file, "title: v6\n");
await new Promise(r=>setTimeout(r,400));
console.log("runs after stop+edit:", runs, "(unchanged:", runs===atStop, ")");
const ok = before >= 1 && afterBurst === 1 && runs === atStop;
console.log(ok ? "\nOK — runs on start, debounces bursts to one, stops cleanly." : "\nFAIL");
process.exit(ok?0:1);
