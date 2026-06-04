import { BrowserSession } from "../dist/browser/session.js";
import { ToolExecutor } from "../dist/browser/tools.js";
import { writeReports } from "../dist/report/reporter.js";
import { toJsonReport } from "../dist/report/json-report.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const runDir = fs.mkdtempSync(path.join(os.tmpdir(),"sn-dlgrep-"));
const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: runDir });
await s.start();
await s.page.setContent(`<button onclick="confirm('Delete EVERYTHING permanently?')">Delete</button>`);
const btn = (await s.snapshot()).elements.find(e=>e.name.includes("Delete"));
await new ToolExecutor(s).execute("click", { index: btn.index });
await s.page.waitForTimeout(200);
const dialogs = s.dialogRecords();
console.log("recorded dialogs:", JSON.stringify(dialogs));
const report = {
  spec:{title:"Delete flow",task:"delete",intent:"item removed",app:{url:"about:blank"}},
  plan:{goal:"g",checkpoints:[]}, steps:[], 
  verdict:{decision:"pass",confidence:0.9,summary:"deleted",checkpoints:[],issues:[]},
  diagnostics: s.diags(), dialogs,
  startedAt:new Date().toISOString(), finishedAt:new Date().toISOString(), durationMs:1000, runDir,
};
await s.close();
writeReports(report);
const md = fs.readFileSync(path.join(runDir,"report.md"),"utf8");
const html = fs.readFileSync(path.join(runDir,"report.html"),"utf8");
const trace = fs.readFileSync(path.join(runDir,"trace.html"),"utf8");
const json = toJsonReport(report);
console.log("MD has dialog:", md.includes("Delete EVERYTHING permanently?"));
console.log("HTML has dialog:", html.includes("Delete EVERYTHING permanently?"));
console.log("trace has dialog:", trace.includes("Delete EVERYTHING permanently?"));
console.log("JSON dialogs:", JSON.stringify(json.dialogs));
const ok = dialogs.length===1 && dialogs[0].action==="accepted" && md.includes("Dialogs auto-handled") && html.includes("Delete EVERYTHING") && trace.includes("Delete EVERYTHING") && json.dialogs.length===1;
console.log(ok ? "\nOK — auto-handled dialog recorded across report.md/html/trace/json." : "\nFAIL");
process.exit(ok?0:1);
