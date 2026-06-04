import { BrowserSession } from "../dist/browser/session.js";
import { compareScreenshots, formatVisual } from "../dist/browser/visual.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(),"sn-vis-"));
async function shot(html){
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: dir });
  await s.start();
  await s.page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
  const buf = await s.screenshotBuffer(true);
  await s.close();
  return buf;
}
const pageA = `<div style="width:300px;height:200px;background:#3366cc;color:#fff;font:24px sans-serif">Dashboard</div>`;
const pageB = `<div style="width:300px;height:200px;background:#cc3333;color:#fff;font:24px sans-serif">Dashboard</div>`; // color changed
// 1) capture baseline
const baseline = await shot(pageA);
fs.writeFileSync(path.join(dir,"baseline.png"), baseline);
console.log("baseline captured:", baseline.length, "bytes");
// 2) identical render -> match
const same = await shot(pageA);
const r1 = compareScreenshots(baseline, same);
console.log("identical:", formatVisual(r1), "| status:", r1.status);
// 3) changed render -> diff + diff image
const changed = await shot(pageB);
const r2 = compareScreenshots(baseline, changed);
console.log("changed:  ", formatVisual(r2), "| status:", r2.status, "| diffPng:", r2.diffPng?.length, "bytes");
if (r2.diffPng) fs.writeFileSync(path.join(dir,"diff.png"), r2.diffPng);
const ok = r1.status==="match" && r2.status==="diff" && r2.mismatchedPixels>1000 && r2.diffPng && r2.diffPng.length>0;
console.log(ok ? "\nOK — baseline match on identical render; pixel diff + diff image on visual change." : "\nFAIL");
process.exit(ok?0:1);
