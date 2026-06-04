// Validates that JS dialogs are auto-handled (no hang) and that a click which
// opens a new tab makes that tab the active page. Real browser, no API key.
import http from "node:http";
import { BrowserSession } from "../dist/browser/session.js";
import { ToolExecutor } from "../dist/browser/tools.js";
import os from "node:os"; import path from "node:path";

// 1) confirm() dialog must not hang and must be recorded.
{
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-dlg") });
  await s.start();
  await s.page.setContent(`<button onclick="if(confirm('Delete this item?')) this.textContent='CONFIRMED'">Delete</button>`);
  const btn = (await s.snapshot()).elements.find(e => e.name.includes("Delete"));
  const ex = new ToolExecutor(s);
  await Promise.race([
    ex.execute("click", { index: btn.index }),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error("HUNG on dialog")), 5000)),
  ]);
  const dialogs = s.drainDialogs();
  const label = await s.page.locator("button").textContent();
  console.log("[dialog] recorded:", JSON.stringify(dialogs), "| button:", label);
  await s.close();
  if (!dialogs.some(d=>d.includes("Delete this item?")) || label!=="CONFIRMED") { console.log("FAIL dialog"); process.exit(1); }
}

// 2) window.open new tab must become active (served over real http).
{
  const server = http.createServer((req,res)=>{ res.writeHead(200,{ "content-type":"text/html" });
    res.end(req.url.startsWith("/target") ? "<h1>NEW TAB PAGE</h1>" : `<button onclick="window.open('/target','_blank')">Open</button>`); });
  await new Promise(r=>server.listen(0,r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-pop") });
  await s.start();
  await s.goto(base + "/");
  const btn = (await s.snapshot()).elements.find(e => e.name.includes("Open"));
  await new ToolExecutor(s).execute("click", { index: btn.index });
  await s.page.waitForTimeout(500);
  const note = s.syncActivePage();
  const snap2 = await s.snapshot();
  console.log("[popup] focus note:", note);
  await s.close(); server.close();
  if (!note || !snap2.text.includes("NEW TAB PAGE")) { console.log("FAIL popup"); process.exit(1); }
}
console.log("\nOK — dialogs auto-handled and new tabs become active.");
