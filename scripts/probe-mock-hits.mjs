import http from "node:http";
import { BrowserSession } from "../dist/browser/session.js";
import os from "node:os"; import path from "node:path";
const server = http.createServer((req,res)=>{
  if (req.url.startsWith("/api/items")) { res.writeHead(200,{ "content-type":"application/json" }); res.end("[]"); return; }
  res.writeHead(200,{ "content-type":"text/html" });
  res.end(`<h1>x</h1><script>fetch('/api/items');fetch('/api/items?page=2');</script>`); // hits items twice
});
await new Promise(r=>server.listen(0,r));
const base = `http://127.0.0.1:${server.address().port}`;
const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-mh"),
  mocks:[
    { url:"**/api/items*", json:[] },        // page hits this twice
    { url:"**/api/MISSPELLED", json:[] },     // never requested
  ]});
await s.start();
await s.goto(base + "/");
await s.page.waitForTimeout(400);
const activity = s.mockActivity();
await s.close(); server.close();
console.log(JSON.stringify(activity, null, 0));
const items = activity.find(a=>a.description.includes("items"));
const missing = activity.find(a=>a.description.includes("MISSPELLED"));
const ok = items.hits===2 && missing.hits===0;
console.log(ok ? "\nOK — mock activity recorded: items hit 2x, misspelled glob flagged never-hit." : "\nFAIL");
process.exit(ok?0:1);
