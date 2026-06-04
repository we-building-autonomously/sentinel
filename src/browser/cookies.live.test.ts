import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";
import { auditCookies } from "./security.js";

let server: http.Server;
let base = "";
let dir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => {
    // A session cookie with no HttpOnly/Secure flags — exactly what the audit flags.
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "sessionid=abc123; Path=/" });
    res.end("<!doctype html><title>App</title><body>ok</body>");
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-ck-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("session cookie capture + audit", () => {
  it("captures cookies with their flags so the audit can flag a weak session cookie", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const cookies = await s.cookies();
    await s.close();

    const sess = cookies.find((c) => c.name === "sessionid");
    expect(sess).toBeDefined();
    expect(sess!.httpOnly).toBe(false);
    // The audit flags the missing HttpOnly (http page → Secure not required).
    const findings = auditCookies(cookies, { https: false });
    expect(findings.some((f) => f.id === "cookie-httponly:sessionid")).toBe(true);
  }, 30_000);
});
