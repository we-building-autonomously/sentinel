import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

// A page that renders the browser's idea of "now" into the DOM on load.
const APP = `<!doctype html><html><head><title>Clock</title></head><body>
<div id="now"></div>
<script>document.getElementById('now').textContent = new Date().toISOString();</script>
</body></html>`;

let server: http.Server;
let base = "";
let dir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(APP)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-clock-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("frozen clock", () => {
  it("makes the app's Date return the configured instant", async () => {
    const frozen = Date.parse("2030-03-15T12:00:00.000Z");
    const s = new BrowserSession({ headed: false, artifactsDir: dir, clockNow: frozen });
    await s.start();
    await s.goto(base);
    const rendered = await s.page.evaluate(() => document.getElementById("now")!.textContent);
    const liveNow = await s.page.evaluate(() => new Date().toISOString());
    await s.close();

    expect(rendered).toBe("2030-03-15T12:00:00.000Z"); // what the page saw at load
    expect(liveNow).toBe("2030-03-15T12:00:00.000Z"); // and still frozen afterwards
  }, 30_000);

  it("uses the real clock when unset", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const year = await s.page.evaluate(() => new Date().getFullYear());
    await s.close();
    expect(year).toBeGreaterThanOrEqual(2026);
  }, 30_000);
});
