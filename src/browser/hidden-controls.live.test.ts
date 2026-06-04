import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";
import { ToolExecutor } from "./tools.js";
import { findElementIndex } from "../testing/callback-llm.js";

let server: http.Server;
let base = "";
let dir = "";

// Three controls that all sit in the DOM:
//   #toggle — a real checkbox at opacity:0 (TodoMVC-style custom toggle) — CLICKABLE
//   #closed-btn — a button inside a CLOSED overlay (opacity:0 + pointer-events:none) — NOT clickable
//   #plain — an ordinary visible button — the control
const PAGE = `<!doctype html><html><head><title>Hidden</title><style>
  #toggle { opacity: 0; width: 40px; height: 40px; }
  .closed { opacity: 0; pointer-events: none; }
</style></head><body>
  <label>Done <input type="checkbox" id="toggle" onclick="document.getElementById('out').textContent='TOGGLED'"></label>
  <div class="closed"><button id="closed-btn" onclick="document.getElementById('out').textContent='LEAK'">Hidden action</button></div>
  <button id="plain" onclick="document.getElementById('out').textContent='PLAIN'">Plain Button</button>
  <div id="out">idle</div>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-hidden-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("opacity:0 interactive controls", () => {
  it("indexes and clicks an opacity:0 checkbox (custom toggle), but skips a closed overlay's button", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    const exec = new ToolExecutor(s);

    // The opacity:0 toggle IS surfaced to the agent...
    const toggleIdx = snap.elements.findIndex((e) => e.type === "checkbox");
    expect(toggleIdx).toBeGreaterThanOrEqual(0);
    // ...the plain button too...
    expect(findElementIndex(snap.rendered, (l) => /Plain Button/.test(l))).toBeGreaterThanOrEqual(0);
    // ...but the CLOSED overlay's button (pointer-events:none) is NOT.
    expect(snap.elements.some((e) => e.name === "Hidden action")).toBe(false);

    // And the opacity:0 checkbox is genuinely clickable through the executor.
    const res = await exec.execute("click", { index: snap.elements[toggleIdx].index });
    const out = await s.page.locator("#out").textContent();
    await s.close();

    expect(res.ok).toBe(true);
    expect(out).toBe("TOGGLED");
  }, 30_000);
});
