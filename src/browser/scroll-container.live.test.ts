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

// A short page (no window scroll) with a fixed-height scrollable list of buttons.
const items = Array.from({ length: 40 }, (_, i) => `<button style="display:block;width:90%;height:28px">Item ${i}</button>`).join("");
const PAGE = `<!doctype html><html><head><title>List</title></head><body style="margin:0;height:300px">
  <div id="list" style="height:150px;overflow-y:scroll;border:1px solid #888">${items}</div>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-scroll-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scroll within a container", () => {
  it("scrolls a fixed-height inner list (not the window)", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const exec = new ToolExecutor(s);
    const before = await s.page.locator("#list").evaluate((el) => el.scrollTop);
    expect(before).toBe(0);

    // Scroll within the container, targeting an item inside it.
    const idx = findElementIndex((await s.snapshot()).rendered, (l) => /"Item 2"/.test(l));
    const res = await exec.execute("scroll", { direction: "down", index: idx });
    const after = await s.page.locator("#list").evaluate((el) => el.scrollTop);
    const windowY = await s.page.evaluate(() => window.scrollY);
    await s.close();

    expect(res.summary).toMatch(/Scrolled down within/);
    expect(after).toBeGreaterThan(0); // the inner list scrolled
    expect(windowY).toBe(0); // the window did not
  }, 30_000);
});
