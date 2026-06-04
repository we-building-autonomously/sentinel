import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

// A login form that, on submit, shows "Invalid credentials".
const PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
  <input id="u" placeholder="Email"><input id="p" type="password" placeholder="Password">
  <button id="go" onclick="document.getElementById('msg').textContent='Invalid credentials'">Sign in</button>
  <div id="msg"></div>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-auth-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("auth-failure detection on a live snapshot", () => {
  it("flags a rejected login in the rendered observation", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    expect((await s.snapshot()).rendered).not.toContain("LOGIN appears to have FAILED");

    await s.page.locator("#go").click(); // submit -> "Invalid credentials"
    const after = await s.snapshot();
    await s.close();
    expect(after.rendered).toMatch(/LOGIN appears to have FAILED/);
  }, 30_000);
});
