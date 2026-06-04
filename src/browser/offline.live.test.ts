import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";
import { ToolExecutor } from "./tools.js";

let server: http.Server;
let base = "";
let dir = "";

// A page whose banner reflects navigator.onLine via the online/offline events.
const PAGE = `<!doctype html><html><head><title>Net</title></head><body>
  <div id="status"></div>
  <script>
    const upd = () => document.getElementById('status').textContent = navigator.onLine ? 'ONLINE' : 'You are OFFLINE';
    addEventListener('online', upd); addEventListener('offline', upd); upd();
  </script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-offline-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("set_network tool", () => {
  it("takes the browser offline (app reacts) and back online", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const exec = new ToolExecutor(s);
    const status = () => s.page.locator("#status").textContent();
    expect(await status()).toBe("ONLINE");

    const off = await exec.execute("set_network", { offline: true });
    expect(off.ok).toBe(true);
    expect(off.summary).toMatch(/OFFLINE/);
    expect(await status()).toBe("You are OFFLINE"); // the offline event fired

    const on = await exec.execute("set_network", { offline: false });
    expect(on.summary).toMatch(/ONLINE/);
    expect(await status()).toBe("ONLINE");
    await s.close();
  }, 30_000);
});
