import http from "node:http";
import { BrowserSession } from "../dist/browser/session.js";
import os from "node:os"; import path from "node:path";
// Real server: /api/items returns 2 real items; the page renders count + error state.
const server = http.createServer((req,res)=>{
  if (req.url.startsWith("/api/items")) { res.writeHead(200,{ "content-type":"application/json" }); res.end(JSON.stringify(["real1","real2"])); return; }
  res.writeHead(200,{ "content-type":"text/html" });
  res.end(`<h1>Items</h1><div id="out">loading</div><script>
    fetch('/api/items').then(r=>r.ok?r.json().then(j=>document.getElementById('out').textContent='COUNT='+j.length):Promise.reject(r.status))
      .catch(s=>document.getElementById('out').textContent='ERROR '+s);</script>`);
});
await new Promise(r=>server.listen(0,r));
const base = `http://127.0.0.1:${server.address().port}`;

async function run(mocks, label) {
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-mock"), mocks });
  await s.start();
  await s.goto(base + "/");
  await s.page.waitForTimeout(300);
  const out = await s.page.locator("#out").textContent();
  await s.close();
  console.log(`${label.padEnd(24)} -> #out="${out}"`);
  return out;
}
const real = await run(undefined, "no mock (real server)");
const empty = await run([{ url:"**/api/items", json:[] }], "mock empty list");
const err = await run([{ url:"**/api/items", status:500, json:{error:"boom"} }], "mock 500");
server.close();
const ok = real==="COUNT=2" && empty==="COUNT=0" && err==="ERROR 500";
console.log(ok ? "\nOK — network mocks override the real server (empty + 500 states tested)." : "\nFAIL");
process.exit(ok?0:1);
