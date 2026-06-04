import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";
import { measureLayout } from "./layout.js";

let server: http.Server;
let base = "";
let dir = "";

const ROUTES: Record<string, string> = {
  "/ok": `<!doctype html><html><head><title>OK</title><meta name=viewport content="width=device-width"></head>
    <body style="margin:0">A normal page.</body></html>`,
  // A fixed 1200px block forces horizontal overflow on a 390px mobile viewport.
  "/overflow": `<!doctype html><html><head><title>Wide</title></head>
    <body style="margin:0"><div style="width:1200px">too wide</div></body></html>`,
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(ROUTES[req.url ?? ""] ?? "<h1>home</h1>");
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-layout-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("measureLayout on a live page", () => {
  it("detects horizontal overflow at a mobile viewport, and not on a normal page", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir, viewport: { width: 390, height: 800 } });
    await s.start();

    await s.goto(`${base}/ok`);
    expect((await measureLayout(s.page)).horizontalOverflow).toBe(false);

    await s.goto(`${base}/overflow`);
    const m = await measureLayout(s.page);
    await s.close();
    expect(m.horizontalOverflow).toBe(true);
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
  }, 30_000);
});
