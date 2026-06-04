// Validates frame-aware indexing: an element INSIDE an iframe must be indexed
// with a unique number and be clickable via the owner-frame resolution.
import { BrowserSession } from "../dist/browser/session.js";
import os from "node:os";
import path from "node:path";

const session = new BrowserSession({
  headed: false,
  actionTimeoutMs: 15000,
  artifactsDir: path.join(os.tmpdir(), "sentinel-iframe"),
});

const html = `<!doctype html><html><body>
  <h1>Outer page</h1>
  <button id="outer">Outer button</button>
  <iframe srcdoc='<!doctype html><html><body>
     <button id="inner" onclick="this.textContent=&apos;CLICKED&apos;">Inner button</button>
  </body></html>' width="400" height="200"></iframe>
</body></html>`;

await session.start();
await session.page.setContent(html, { waitUntil: "load" });
await session.page.waitForTimeout(300);

const snap = await session.snapshot();
console.log("Total elements across frames:", snap.elements.length);
console.log(snap.rendered);

const inner = snap.elements.find((e) => e.name.includes("Inner button"));
if (!inner) {
  console.error("FAIL: inner iframe button was not indexed");
  await session.close();
  process.exit(1);
}
console.log(`\nInner button indexed as [${inner.index}] — clicking it through the owner frame...`);

const { ToolExecutor } = await import("../dist/browser/tools.js");
const ex = new ToolExecutor(session);
const r = await ex.execute("click", { index: inner.index });
console.log("[click result]", r.summary);

// Read the inner frame's state to confirm the click landed inside the iframe.
const frame = session.page.frames().find((f) => f !== session.page.mainFrame());
const label = await frame.locator("#inner").textContent();
const ok = label === "CLICKED";
console.log("Inner frame click took effect:", ok, `(button text="${label}")`);

await session.close();
if (!ok) process.exit(1);
console.log("\nOK — iframe elements are indexed and clickable.");
