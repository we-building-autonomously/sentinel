import { BrowserSession } from "../dist/browser/session.js";
import { resolveViewport } from "../dist/browser/viewport.js";
import os from "node:os"; import path from "node:path";
const PAGE = `<meta name='viewport' content='width=device-width,initial-scale=1'><h1>vp</h1>`;
async function probe(name) {
  const vp = resolveViewport(name);
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: path.join(os.tmpdir(),"sn-vp"),
    viewport: vp.viewport, userAgent: vp.userAgent, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor });
  await s.start();
  await s.page.setContent(PAGE);
  const info = await s.page.evaluate(() => ({
    w: window.innerWidth, touch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
    ua: navigator.userAgent, dpr: window.devicePixelRatio,
  }));
  await s.close();
  console.log(`${vp.label.padEnd(12)} → innerWidth=${info.w}  touch=${info.touch}  dpr=${info.dpr}  ua=${/iPhone|Mobile/.test(info.ua)?'mobile':'desktop'}`);
  return info;
}
const desk = await probe("desktop");
const mob = await probe("mobile");
const iph = await probe("iPhone 13");
const ok = desk.w===1280 && mob.w===390 && mob.touch && iph.w<500 && /iPhone/.test(iph.ua) && iph.touch;
console.log(ok ? "\nOK — viewport/device emulation applies width, touch, DPR and UA." : "\nFAIL");
process.exit(ok?0:1);
