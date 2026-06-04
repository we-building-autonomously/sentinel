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

// One target records the last interaction: right-click, double-click, ctrl-click.
const PAGE = `<!doctype html><html><head><title>Menu</title></head><body>
  <button id="t" tabindex="0"
    oncontextmenu="event.preventDefault();document.getElementById('out').textContent='CONTEXT';return false"
    ondblclick="document.getElementById('out').textContent='DOUBLE'"
    onclick="document.getElementById('out').textContent=event.shiftKey?'SHIFT':'PLAIN'">Item</button>
  <div id="out">idle</div>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-clickmod-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("click modifiers", () => {
  it("supports right-click, double-click and modifier-click", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const exec = new ToolExecutor(s);
    const out = () => s.page.locator("#out").textContent();
    const idx = findElementIndex((await s.snapshot()).rendered, (l) => /"Item"/.test(l));

    const rc = await exec.execute("click", { index: idx, button: "right" });
    expect(rc.summary).toMatch(/Right-Clicked/);
    expect(await out()).toBe("CONTEXT");

    const dc = await exec.execute("click", { index: idx, double: true });
    expect(dc.summary).toMatch(/Double-Clicked/);
    expect(await out()).toBe("DOUBLE");

    // (Use Shift, not Control — on macOS Ctrl+click is the OS context-menu gesture.)
    const mc = await exec.execute("click", { index: idx, modifiers: ["Shift"] });
    expect(mc.summary).toMatch(/Shift\+Clicked/);
    expect(await out()).toBe("SHIFT");

    await s.close();
  }, 30_000);
});
