import { expandMatrix } from "../dist/suite.js";
import { resolveViewport } from "../dist/browser/viewport.js";
import { BrowserSession } from "../dist/browser/session.js";
import os from "node:os"; import path from "node:path";
// One spec, matrixed across desktop + mobile.
const specs = [{ title:"Checkout", task:"buy", intent:"order placed", app:{url:"about:blank"} }];
const variants = expandMatrix(specs, { viewport:["desktop","mobile"] });
console.log("variants:", variants.map(v=>v.title).join(" | "));
const widths = {};
for (const v of variants) {
  const vp = resolveViewport(v.viewport);
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-mx"),
    viewport: vp.viewport, userAgent: vp.userAgent, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor });
  await s.start();
  await s.page.setContent("<meta name='viewport' content='width=device-width,initial-scale=1'><h1>x</h1>");
  const w = await s.page.evaluate(()=>window.innerWidth);
  widths[v.title] = w;
  await s.close();
  console.log(`  ${v.title.padEnd(20)} -> innerWidth=${w}`);
}
const ok = variants.length===2 && widths["Checkout [desktop]"]===1280 && widths["Checkout [mobile]"]===390;
console.log(ok ? "\nOK — matrix expands a spec across viewports and each runs at its real size." : "\nFAIL");
process.exit(ok?0:1);
