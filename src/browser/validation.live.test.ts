import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

// Submitting empty flags the email field aria-invalid (a common SPA pattern).
const PAGE = `<!doctype html><html><head><title>Signup</title></head><body>
  <input id="email" type="email" placeholder="Email" required>
  <button id="go" onclick="var e=document.getElementById('email'); if(!e.value) e.setAttribute('aria-invalid','true')">Sign up</button>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-val-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("form-validation state in the snapshot", () => {
  it("surfaces [required] and, after a failed submit, [invalid] on the field", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);

    const before = await s.snapshot();
    expect(before.rendered).toMatch(/"Email".*\[required\]/);
    expect(before.rendered).not.toContain("[invalid]");

    await s.page.locator("#go").click(); // submit empty -> flags invalid
    const after = await s.snapshot();
    await s.close();

    expect(after.rendered).toMatch(/"Email".*\[invalid\]/);
    // The invalid flag is on the email field (so the agent can target it).
    expect(after.elements.find((e) => e.name === "Email")?.invalid).toBe(true);
  }, 30_000);
});
