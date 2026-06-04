import http from "node:http";
import { BrowserSession } from "../dist/browser/session.js";
import { ToolExecutor } from "../dist/browser/tools.js";
import os from "node:os"; import path from "node:path";

// --- hover reveals a CSS-only submenu, then we click the revealed item ---
{
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-hover") });
  await s.start();
  await s.page.setContent(`<style>
    #menu ul{display:none} #menu:hover ul{display:block}
  </style>
  <nav id="menu"><button id="trig">Account ▾</button>
    <ul><li><a id="logout" href="#" onclick="document.title='LOGGED_OUT'">Log out</a></li></ul>
  </nav>`);
  let snap = await s.snapshot();
  const trig = snap.elements.find(e=>e.name.includes("Account"));
  const ex = new ToolExecutor(s);
  // Before hover, the Log out link is hidden (not indexed).
  const beforeHasLogout = snap.elements.some(e=>e.name.includes("Log out"));
  const hr = await ex.execute("hover", { index: trig.index });
  snap = await s.snapshot();
  const afterHasLogout = snap.elements.some(e=>e.name.includes("Log out"));
  const logout = snap.elements.find(e=>e.name.includes("Log out"));
  await ex.execute("click", { index: logout.index });
  const title = await s.page.title();
  console.log(`[hover] ${hr.summary} | logout hidden before: ${!beforeHasLogout}, revealed after: ${afterHasLogout}, click effect: ${title==='LOGGED_OUT'}`);
  await s.close();
  if (beforeHasLogout || !afterHasLogout || title!=='LOGGED_OUT') { console.log("FAIL hover"); process.exit(1); }
}

// --- go_back returns to the previous page ---
{
  const server = http.createServer((req,res)=>{ res.writeHead(200,{ "content-type":"text/html" });
    res.end(req.url.startsWith("/page2") ? "<h1>PAGE TWO</h1>" : `<h1>PAGE ONE</h1><a href="/page2">Go</a>`); });
  await new Promise(r=>server.listen(0,r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-back") });
  await s.start();
  await s.goto(base+"/");
  const link = (await s.snapshot()).elements.find(e=>e.name.includes("Go"));
  const ex = new ToolExecutor(s);
  await ex.execute("click", { index: link.index });
  const onPage2 = (await s.snapshot()).text.includes("PAGE TWO");
  const br = await ex.execute("go_back", {});
  const backOnPage1 = (await s.snapshot()).text.includes("PAGE ONE");
  console.log(`[go_back] reached page2: ${onPage2} | ${br.summary} | back on page1: ${backOnPage1}`);
  await s.close(); server.close();
  if (!onPage2 || !backOnPage1) { console.log("FAIL go_back"); process.exit(1); }
}
console.log("\nOK — hover reveals & clicks submenu items; go_back navigates history.");
