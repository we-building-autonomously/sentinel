// Standalone probe: validates session + indexer against a real page (no LLM/key needed).
import { BrowserSession } from "../dist/browser/session.js";
import os from "node:os";
import path from "node:path";

const url = process.argv[2] ?? "https://demo.playwright.dev/todomvc/";
const session = new BrowserSession({
  headed: false,
  actionTimeoutMs: 15000,
  artifactsDir: path.join(os.tmpdir(), "sentinel-probe"),
});

await session.start();
await session.goto(url);
const snap = await session.snapshot();
console.log("URL:", snap.url);
console.log("Title:", snap.title);
console.log("Elements found:", snap.elements.length);
console.log("--- rendered ---");
console.log(snap.rendered.slice(0, 1500));

// Exercise a real action via the executor path: type into the first textbox.
const { ToolExecutor } = await import("../dist/browser/tools.js");
const ex = new ToolExecutor(session);
const inputEl = snap.elements.find((e) => e.tag === "input" || e.role === "textbox");
if (inputEl) {
  const r = await ex.execute("type", { index: inputEl.index, text: "Buy milk", submit: true });
  console.log("\n[type result]", r.summary);
  const snap2 = await session.snapshot();
  console.log("After action, elements:", snap2.elements.length);
  console.log("Page mentions 'Buy milk':", snap2.text.includes("Buy milk"));
}
await session.close();
console.log("\nOK — perception + action layer works.");
