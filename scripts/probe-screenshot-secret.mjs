import { runAgent } from "../dist/agent/loop.js";
import { BrowserSession } from "../dist/browser/session.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const ART = fs.mkdtempSync(path.join(os.tmpdir(),"sn-sss-"));
const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: ART });
await s.start();
// Clicking "Reveal" injects a freshly-minted API key into the page (secret on screen).
await s.page.setContent(`<button id="r" onclick="document.getElementById('out').textContent='Your key: cwz_9528d50a09da3f75be1fb07928c1466c0ec390955272cc08 — copy now'">Reveal</button><div id="out">no key yet</div>`);
const script = [
  { id:"a", name:"scroll", input:{direction:"down"} },      // step 0: page has NO secret -> screenshot kept
  { id:"b", name:"click", input:{index:0} },                // step 1: reveals the secret -> screenshot suppressed
  { id:"c", name:"done", input:{outcome:"success",notes:"ok"} },
];
let i=0;
const fakeLlm = { turn: async()=>({ text:"act", toolUses:[script[Math.min(i++,2)]], raw:[{type:"text",text:"x"}], stopReason:"tool_use", usage:{input:1,output:1} }) };
const run = await runAgent({ llm: fakeLlm, session: s, plan:{goal:"g",checkpoints:[]}, maxSteps:6 });
await s.close();
const scrollStep = run.steps.find(st=>st.call.name==="scroll");
const clickStep = run.steps.find(st=>st.call.name==="click");
console.log("scroll step screenshot:", scrollStep.result.screenshot, "(kept)");
console.log("scroll png exists on disk:", scrollStep.result.screenshot ? fs.existsSync(path.join(ART, scrollStep.result.screenshot)) : "n/a");
console.log("click step screenshot:", clickStep.result.screenshot, "(should be undefined)");
console.log("click step summary:", clickStep.result.summary);
// confirm NO png on disk contains the secret-bearing frame: the click screenshot file should be gone
const pngs = fs.readdirSync(ART).filter(f=>f.endsWith(".png"));
console.log("png files remaining:", pngs.join(", "));
const ok = scrollStep.result.screenshot && clickStep.result.screenshot===undefined &&
  /withheld — page displayed a secret/.test(clickStep.result.summary) &&
  !pngs.includes("001-click.png");
console.log(ok ? "\nOK — the secret-bearing screenshot was suppressed (deleted); the safe one kept." : "\nFAIL");
process.exit(ok?0:1);
