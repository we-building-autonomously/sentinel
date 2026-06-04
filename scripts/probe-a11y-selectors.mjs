import { BrowserSession } from "../dist/browser/session.js";
import { runA11y } from "../dist/browser/a11y.js";
import os from "node:os"; import path from "node:path";
const s = new BrowserSession({ headed:false, actionTimeoutMs:8000, artifactsDir: path.join(os.tmpdir(),"sn-a11ysel") });
await s.start();
await s.page.setContent(`<!doctype html><html lang="en"><head><title>t</title></head><body>
  <main><img id="logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">
  <button class="cta"></button></main></body></html>`);
const r = await runA11y(s.page);
await s.close();
const imgAlt = r.violations.find(v=>v.id==="image-alt");
const btn = r.violations.find(v=>v.id==="button-name");
console.log("image-alt selectors:", JSON.stringify(imgAlt?.selectors));
console.log("button-name selectors:", JSON.stringify(btn?.selectors));
const ok = imgAlt && imgAlt.selectors.length>0 && imgAlt.selectors[0].includes("#logo") &&
  btn && btn.selectors[0].includes("button");
console.log(ok ? "\nOK — axe node selectors surfaced (which element to fix)." : "\nFAIL");
process.exit(ok?0:1);
