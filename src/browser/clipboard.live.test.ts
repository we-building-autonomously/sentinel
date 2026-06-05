import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

// A "Copy API key" button that writes to the clipboard via navigator.clipboard.
const PAGE = `<!doctype html><html><head><title>Keys</title></head><body>
  <button id="copy" onclick="navigator.clipboard.writeText('tok_live_abc123')">Copy API key</button>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-clip-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("clipboard capture", () => {
  it("records what a Copy button wrote to the clipboard", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    expect(await s.clipboardWrites()).toEqual([]); // nothing copied yet

    await s.page.locator("#copy").click();
    const writes = await s.clipboardWrites();
    await s.close();

    expect(writes.some((w) => w.includes("tok_live_abc123"))).toBe(true);
  }, 30_000);
});
