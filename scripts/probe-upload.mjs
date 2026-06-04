import { BrowserSession } from "../dist/browser/session.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"sn-up-"));
const file = path.join(tmp, "avatar.png");
fs.writeFileSync(file, "PNGDATA");

const PAGE = `<input id="f" type="file"><div id="out">none</div>
  <script>document.getElementById('f').addEventListener('change',e=>{
    document.getElementById('out').textContent='UPLOADED:'+e.target.files[0].name+':'+e.target.files[0].size;});</script>`;

async function run(uploads, label){
  const s = new BrowserSession({ headed:false, actionTimeoutMs:6000, artifactsDir: tmp, uploads });
  await s.start();
  await s.page.setContent(PAGE);
  // Click the file input -> opens native chooser. Must NOT hang.
  const clicked = await Promise.race([
    s.page.click("#f").then(()=>true),
    new Promise(r=>setTimeout(()=>r("HANG"),4000)),
  ]);
  await s.page.waitForTimeout(200);
  const out = await s.page.locator("#out").textContent();
  const log = s.uploads();
  await s.close();
  console.log(`${label.padEnd(18)} clicked=${clicked} | #out="${out}" | log=${JSON.stringify(log)}`);
  return { clicked, out, log };
}

const withFile = await run([file], "with file");
const noFile = await run(undefined, "no file");
const ok = withFile.clicked===true && /UPLOADED:avatar.png:7/.test(withFile.out) && withFile.log[0]==="avatar.png" &&
  noFile.clicked===true && noFile.log[0].includes("cancelled");
console.log(ok ? "\nOK — file chooser auto-handled: real upload attaches the file, no-file cancels; never hangs." : "\nFAIL");
process.exit(ok?0:1);
