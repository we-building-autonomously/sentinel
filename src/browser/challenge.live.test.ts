import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

// Two routes: "/otp" has an addressable input behind a 2FA prompt; "/wall" is a
// bare verification interstitial with NOTHING to click (the hard case).
const ROUTES: Record<string, string> = {
  "/otp": `<!doctype html><html><head><title>Verify</title></head><body>
    <h1>Two-factor authentication</h1>
    <p>Enter the 6-digit code we sent to your phone.</p>
    <input id="code" placeholder="Code"><button>Verify</button></body></html>`,
  "/wall": `<!doctype html><html><head><title>Almost there</title></head><body>
    <h1>Check your inbox</h1>
    <p>We've sent you a verification link. Click the link in your email to finish.</p>
    </body></html>`,
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(ROUTES[req.url ?? ""] ?? "<h1>home</h1>");
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-chal-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("challenge detection on a live snapshot", () => {
  it("flags a 2FA wall in the rendered observation and on the snapshot", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(`${base}/otp`);
    const snap = await s.snapshot();
    await s.close();

    expect(snap.challenge?.kind).toBe("2fa-otp");
    expect(snap.rendered).toMatch(/EXTERNAL CHALLENGE \(2fa-otp\)/);
    // The banner sits above the still-present interactable elements.
    expect(snap.rendered).toMatch(/\[\d+\]/);
  }, 30_000);

  it("still shows the banner when the wall has no interactable elements", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(`${base}/wall`);
    const snap = await s.snapshot();
    await s.close();

    expect(snap.challenge?.kind).toBe("email-verification");
    // (none detected) alone would leave the agent with no idea why it's stuck.
    expect(snap.rendered).toMatch(/EXTERNAL CHALLENGE \(email-verification\)/);
    expect(snap.rendered).toContain("(none detected)");
  }, 30_000);
});
