import { runAgent } from "../dist/agent/loop.js";
import { BrowserSession } from "../dist/browser/session.js";
import os from "node:os"; import path from "node:path";
const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-dedup") });
await s.start();
await s.page.setContent("<h1>Static page</h1><button>Noop</button>");
// extract is a read-only action -> the page is byte-identical after it.
const script = [
  { name:"extract", input:{query:"the heading"} },
  { name:"extract", input:{query:"the heading again"} },
  { name:"done", input:{outcome:"success",notes:"ok"} },
];
let i=0;
let sawUnchanged = false;
let fullObsCount = 0;
const fakeLlm = {
  turn: async (opts) => {
    // Inspect what the loop sent us this turn.
    const text = JSON.stringify(opts.messages);
    if (text.includes("PAGE UNCHANGED")) sawUnchanged = true;
    fullObsCount = (text.match(/=== PAGE OBSERVATION ===/g) || []).length;
    const a = script[Math.min(i++, script.length-1)];
    return { text:"act", toolUses:[{id:"t"+i, name:a.name, input:a.input}], raw:[{type:"text",text:"x"}], stopReason:"tool_use", usage:{input:1,output:1} };
  },
  structured: async () => ({ found:true, answer:"Static page" }),
};
await runAgent({ llm: fakeLlm, session: s, plan:{goal:"g",checkpoints:[]}, maxSteps:6 });
await s.close();
console.log("saw PAGE UNCHANGED note:", sawUnchanged);
console.log("full observations in final context:", fullObsCount, "(deduped: stays low despite repeated steps)");
console.log(sawUnchanged ? "\nOK — identical observations collapse to a note (token saving)." : "\nFAIL");
process.exit(sawUnchanged ? 0 : 1);
