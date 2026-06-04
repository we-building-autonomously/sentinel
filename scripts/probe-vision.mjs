import { BrowserSession } from "../dist/browser/session.js";
import { ToolExecutor } from "../dist/browser/tools.js";
import { shouldUseVision } from "../dist/browser/indexer.js";
import os from "node:os"; import path from "node:path";
const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-vision") });
await s.start();
// A canvas app: clicking the canvas records the click coordinates into a hidden div.
await s.page.setContent(`
  <canvas id="c" width="500" height="400" style="border:1px solid"></canvas>
  <div id="log">none</div>
  <script>
    const c=document.getElementById('c');
    c.addEventListener('click', e=>{
      const r=c.getBoundingClientRect();
      document.getElementById('log').textContent='HIT '+Math.round(e.clientX-r.left)+','+Math.round(e.clientY-r.top);
    });
  </script>`);
const snap = await s.snapshot();
console.log("elements:", snap.elements.length, "| hasCanvas:", snap.hasCanvas, "| shouldUseVision:", shouldUseVision(snap));
// Confirm a screenshot can be captured for the observation.
const shot = await s.screenshotBase64();
console.log("screenshot:", shot.width+"x"+shot.height, "| base64 bytes:", shot.data.length);
// Use the coordinate tool to click inside the canvas.
const ex = new ToolExecutor(s);
const r = await ex.execute("click_at", { x: 60, y: 70 });
await s.page.waitForTimeout(200);
const log = await s.page.locator("#log").textContent();
console.log("click_at result:", r.summary, "| canvas log:", log);
await s.close();
const ok = snap.hasCanvas && shouldUseVision(snap) && shot.data.length>1000 && log.startsWith("HIT");
console.log(ok ? "\nOK — vision mode triggers on canvas, screenshot captured, click_at lands." : "\nFAIL");
process.exit(ok?0:1);
