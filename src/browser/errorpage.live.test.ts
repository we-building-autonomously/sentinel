import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

// A 200-status page that nonetheless renders a crash screen (an SPA error
// boundary): the response status is fine, so only text detection catches it.
const PAGE = `<!doctype html><html><head><title>App</title></head><body>
  <h1>Something went wrong</h1>
  <p>We're sorry, but something went wrong. Our team has been notified.</p>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-err-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("error-state detection on a live snapshot", () => {
  it("flags a 200-status crash screen on the snapshot and in the observation", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    await s.close();

    expect(snap.errorState?.kind).toBe("generic-error");
    expect(snap.rendered).toMatch(/ERROR PAGE \(generic-error\)/);
  }, 30_000);
});
