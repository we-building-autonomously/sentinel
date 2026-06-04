import { BrowserSession } from "../dist/browser/session.js";
import { ToolExecutor } from "../dist/browser/tools.js";
import { MAX_RENDERED_ELEMENTS } from "../dist/browser/indexer.js";
import os from "node:os"; import path from "node:path";
const s = new BrowserSession({ headed:false, actionTimeoutMs:8000, artifactsDir: path.join(os.tmpdir(),"sn-cap") });
await s.start();
// 300 buttons; the last one (#299, far below the fold) records a click.
let html = "<h1>Big page</h1>";
for (let i=0;i<300;i++) html += `<button onclick="this.textContent='HIT${i}'">Btn ${i}</button><br>`;
await s.page.setContent(html);
const snap = await s.snapshot();
const renderedCount = (snap.rendered.match(/^\[\d+\]/gm) || []).length;
console.log("total elements indexed:", snap.elements.length);
console.log("rendered (shown) count:", renderedCount, "(cap:", MAX_RENDERED_ELEMENTS+")");
console.log("omission note present:", /more interactable element\(s\) off-screen/.test(snap.rendered));
// Crucial: an element NOT shown in the rendered list is still clickable by index.
const hidden = snap.elements.find(e => e.index === 250); // beyond the cap, off-screen
const shownHas250 = new RegExp(`^\\[250\\]`, "m").test(snap.rendered);
const ex = new ToolExecutor(s);
const r = await ex.execute("click", { index: 250 });
const text = await s.page.locator('button >> nth=250').textContent();
console.log("index 250 shown in observation:", shownHas250, "| still clickable:", r.ok, "| effect:", text==='HIT250');
await s.close();
const ok = snap.elements.length===300 && renderedCount<=MAX_RENDERED_ELEMENTS && /off-screen/.test(snap.rendered) && r.ok && text==='HIT250';
console.log(ok ? "\nOK — large page capped in view, all elements still addressable by index." : "\nFAIL");
process.exit(ok?0:1);
