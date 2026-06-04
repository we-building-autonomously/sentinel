import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

// A page with a cookie banner overlaying the real content (an Accept button +
// the actual app underneath).
const PAGE = `<!doctype html><html><head><title>Shop</title></head><body>
  <h1>Storefront</h1>
  <button id="buy">Buy now</button>
  <div id="cc" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:12px">
    We use cookies to improve your experience.
    <button id="accept">Accept all</button>
  </div>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-consent-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("consent banner on a live snapshot", () => {
  it("flags the cookie banner in the rendered observation above the elements", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    await s.close();

    expect(snap.rendered).toMatch(/COOKIE\/CONSENT BANNER/);
    // The note sits above the still-addressable controls (Accept + Buy).
    expect(snap.rendered).toMatch(/\[\d+\][^\n]*Accept all/);
    expect(snap.rendered).toMatch(/\[\d+\][^\n]*Buy now/);
    const noteIdx = snap.rendered.indexOf("COOKIE/CONSENT");
    const firstEl = snap.rendered.search(/\[\d+\]/);
    expect(noteIdx).toBeLessThan(firstEl);
  }, 30_000);
});
