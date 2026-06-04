import { scanRuns, buildHistory, writeHistory } from "../dist/report/history.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(),"sn-reg-"));
function writeRun(name, title, decision, startedAt) {
  const dir = path.join(runsDir, name); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"report.json"), JSON.stringify({
    spec:{title,task:"x",intent:"y",app:{url:"https://e.com"}}, plan:{goal:"g",checkpoints:[]}, steps:[],
    verdict:{decision,confidence:1,summary:"s",checkpoints:[],issues:[]},
    usage:{byModel:{},total:{input:0,output:0,cacheRead:0,cacheWrite:0,calls:0},costUsd:0.01},
    startedAt, finishedAt:startedAt, durationMs:2000, runDir:dir }));
}
// Checkout: passed, then failed today -> REGRESSED
writeRun("co-1","Checkout","pass","2026-06-01T10:00:00Z");
writeRun("co-2","Checkout","pass","2026-06-02T10:00:00Z");
writeRun("co-3","Checkout","fail","2026-06-03T10:00:00Z");
// Login: failed, then passed today -> FIXED
writeRun("lo-1","Login","fail","2026-06-01T09:00:00Z");
writeRun("lo-2","Login","pass","2026-06-03T09:00:00Z");
// Search: always passing -> STABLE
writeRun("se-1","Search","pass","2026-06-01T08:00:00Z");
writeRun("se-2","Search","pass","2026-06-03T08:00:00Z");

const h = buildHistory(scanRuns(runsDir));
console.log("regressed:", h.totals.regressed, "| fixed:", h.totals.fixed);
console.log("order (regressions first):", h.specs.map(s=>`${s.title}:${s.trend}`).join(", "));
const out = path.join(runsDir,"index.html"); writeHistory(runsDir, out);
const html = fs.readFileSync(out,"utf8");
const ok = h.totals.regressed===1 && h.totals.fixed===1 && h.specs[0].title==="Checkout" && h.specs[0].trend==="regressed" &&
  html.includes("1 spec(s) regressed") && html.includes("▼ regressed") && html.includes("▲ fixed");
console.log(ok ? "\nOK — regression/fix detected, sorted to top, bannered in the dashboard." : "\nFAIL");
process.exit(ok?0:1);
