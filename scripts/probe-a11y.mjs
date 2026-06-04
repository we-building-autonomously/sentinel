import { BrowserSession } from "../dist/browser/session.js";
import { runA11y, formatA11y } from "../dist/browser/a11y.js";
import os from "node:os"; import path from "node:path";
const s = new BrowserSession({ headed:false, actionTimeoutMs:8000, artifactsDir: path.join(os.tmpdir(),"sn-a11y") });
await s.start();
// Deliberate violations: image with no alt, a button with no accessible name, low contrast.
await s.page.setContent(`<!doctype html><html lang="en"><head><title>t</title></head><body>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="50" height="50">
  <button></button>
  <p style="color:#bbb;background:#ccc">hard to read text</p>
  <a href="#"></a>
</body></html>`);
const r = await runA11y(s.page);
await s.close();
console.log("summary:", formatA11y(r));
console.log("violation ids:", r.violations.map(v=>`${v.impact}:${v.id}`).join(", "));
const ids = r.violations.map(v=>v.id);
const hasImgAlt = ids.includes("image-alt");
const ok = r.violations.length >= 2 && hasImgAlt && r.violations[0].impact==="critical";
console.log(ok ? "\nOK — axe-core injected and detected real a11y violations (image-alt critical, sorted first)." : "\nFAIL");
process.exit(ok?0:1);
