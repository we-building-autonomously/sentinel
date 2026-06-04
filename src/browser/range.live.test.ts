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

// A range slider AND a color picker, each mirroring its value into an output.
const PAGE = `<!doctype html><html><head><title>Filter</title></head><body>
  <input id="price" type="range" min="0" max="100" value="0" aria-label="Price"
    oninput="document.getElementById('out').textContent=this.value">
  <output id="out">0</output>
  <input id="theme" type="color" value="#000000" aria-label="Theme color"
    oninput="document.getElementById('cout').textContent=this.value">
  <output id="cout">#000000</output>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-range-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("type on non-fillable inputs (range / color)", () => {
  it("sets a range slider and a color picker, firing input/change so the app reacts", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    const exec = new ToolExecutor(s);

    const rangeIdx = findElementIndex(snap.rendered, (l) => /"Price"|type=range/.test(l));
    const rangeRes = await exec.execute("type", { index: rangeIdx, text: "75" });
    expect(rangeRes.ok).toBe(true);
    expect(rangeRes.summary).toMatch(/Set range input/);
    expect(await s.page.locator("#price").inputValue()).toBe("75");
    expect(await s.page.locator("#out").textContent()).toBe("75"); // input event fired

    const colorIdx = findElementIndex(snap.rendered, (l) => /"Theme color"|type=color/.test(l));
    const colorRes = await exec.execute("type", { index: colorIdx, text: "#ff0000" });
    expect(colorRes.ok).toBe(true);
    expect(colorRes.summary).toMatch(/Set color input/);
    expect(await s.page.locator("#theme").inputValue()).toBe("#ff0000");
    expect(await s.page.locator("#cout").textContent()).toBe("#ff0000");

    await s.close();
  }, 30_000);
});
