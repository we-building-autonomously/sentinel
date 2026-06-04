import { runAgent } from "../dist/agent/loop.js";
import { BrowserSession } from "../dist/browser/session.js";
import { writeReports } from "../dist/report/reporter.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const runDir = fs.mkdtempSync(path.join(os.tmpdir(),"sn-annot-"));
const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: runDir });
await s.start();
await s.page.setContent(`<div style="height:40px"></div>
  <input placeholder="name" style="margin:20px">
  <button style="margin:20px">Save</button>`);
// Fake LLM: type into the input, click Save, done.
const script = [
  { id:"a", name:"type", input:{index:0,text:"Ada"} },
  { id:"b", name:"click", input:{index:1} },
  { id:"c", name:"done", input:{outcome:"success",notes:"ok"} },
];
let i=0;
const fakeLlm = { turn: async()=>({ text:"act", toolUses:[script[Math.min(i++,script.length-1)]], raw:[{type:"text",text:"x"}], stopReason:"tool_use", usage:{input:1,output:1} }) };
const run = await runAgent({ llm: fakeLlm, session: s, plan:{goal:"g",checkpoints:[]}, maxSteps:6 });
await s.close();
const typeStep = run.steps.find(st=>st.call.name==="type");
const clickStep = run.steps.find(st=>st.call.name==="click");
console.log("type target:", JSON.stringify(typeStep.result.target));
console.log("click target:", JSON.stringify(clickStep.result.target));
const report = { spec:{title:"Annot",task:"t",intent:"i",app:{url:"about:blank"}},
  plan:{goal:"g",checkpoints:[]}, steps:run.steps,
  verdict:{decision:"pass",confidence:1,summary:"ok",checkpoints:[],issues:[]},
  startedAt:new Date().toISOString(), finishedAt:new Date().toISOString(), durationMs:1000, runDir };
writeReports(report);
const trace = fs.readFileSync(path.join(runDir,"trace.html"),"utf8");
const hasHl = trace.includes('id="hl"') && trace.includes('img.naturalWidth');
const hasTargetData = /"target":\{"x":\d+/.test(trace);
console.log("trace has highlight overlay + scaling JS:", hasHl);
console.log("trace embeds target coords:", hasTargetData);
const ok = typeStep.result.target && typeStep.result.target.w>0 && clickStep.result.target && hasHl && hasTargetData;
console.log(ok ? "\nOK — element bboxes captured and highlight overlay wired into the trace." : "\nFAIL");
process.exit(ok?0:1);
