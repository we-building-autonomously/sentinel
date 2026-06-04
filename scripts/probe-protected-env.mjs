import http from "node:http";
import { BrowserSession } from "../dist/browser/session.js";
import os from "node:os"; import path from "node:path";
// A server that requires: a bypass header OR basic auth, and echoes a cookie.
const server = http.createServer((req,res)=>{
  const hdr = req.headers["x-bypass-token"];
  const auth = req.headers["authorization"];
  const cookie = req.headers["cookie"] || "";
  const okHeader = hdr === "let-me-in";
  const okBasic = auth === "Basic " + Buffer.from("stage:pw123").toString("base64");
  if (!okHeader && !okBasic) { res.writeHead(401, { "WWW-Authenticate": "Basic realm=staging" }); res.end("denied"); return; }
  res.writeHead(200,{ "content-type":"text/html" });
  res.end(`<h1>PROTECTED OK</h1><p>cookie=${cookie}</p>`);
});
await new Promise(r=>server.listen(0,r));
const base = `http://127.0.0.1:${server.address().port}`;

async function tryWith(opts, label) {
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-prot"), ...opts });
  await s.start();
  const nav = await s.goto(base + "/");
  const txt = (await s.snapshot()).text;
  await s.close();
  const ok = txt.includes("PROTECTED OK");
  console.log(`${label.padEnd(22)} -> status=${nav.status} access=${ok} ${/flag=on/.test(txt)?'(cookie seen)':''}`);
  return { ok, txt };
}

const noAuth = await tryWith({}, "no creds");
const viaHeader = await tryWith({ extraHTTPHeaders:{ "x-bypass-token":"let-me-in" } }, "bypass header");
const viaBasic = await tryWith({ httpCredentials:{ username:"stage", password:"pw123" } }, "basic auth");
const viaCookie = await tryWith({ extraHTTPHeaders:{ "x-bypass-token":"let-me-in" },
  cookies:[{ name:"flag", value:"on", url: base }] }, "header + cookie");
server.close();
const ok = !noAuth.ok && viaHeader.ok && viaBasic.ok && viaCookie.ok && /flag=on/.test(viaCookie.txt);
console.log(ok ? "\nOK — header bypass, basic auth, and cookie seeding all reach a protected server." : "\nFAIL");
process.exit(ok?0:1);
