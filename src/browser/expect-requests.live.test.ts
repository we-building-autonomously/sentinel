import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";
import { ToolExecutor } from "./tools.js";
import { findElementIndex } from "../testing/callback-llm.js";
import { evaluateRequestExpectations } from "./expect-requests.js";

let server: http.Server;
let base = "";
let dir = "";

// Clicking "Save" fires a real POST /api/save; the request log should capture it.
const PAGE = `<!doctype html><html><head><title>Editor</title></head><body>
  <button id="save" onclick="fetch('/api/save',{method:'POST',body:JSON.stringify({doc:'readme',action:'save'})})">Save</button>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/save") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-req-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("request-log capture + expectations end-to-end", () => {
  it("records the POST the app made and evaluates expectations against it", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    const exec = new ToolExecutor(s);
    await exec.execute("click", { index: findElementIndex(snap.rendered, (l) => /"Save"/.test(l)) });
    await s.page.waitForTimeout(300); // let the fetch land

    const checks = evaluateRequestExpectations(s.requestLog(), [
      { url: "/api/save", method: "POST" }, // should be met
      { url: "/api/save", method: "POST", bodyIncludes: "readme" }, // body match
      { url: "/api/save", method: "POST", bodyIncludes: "deleted" }, // body mismatch
      { url: "/api/delete", method: "POST" }, // should be unmet
    ]);
    await s.close();

    expect(checks[0].met).toBe(true);
    expect(checks[0].observed).toBeGreaterThanOrEqual(1);
    expect(checks[1].met).toBe(true); // the POST body contained "readme"
    expect(checks[2].met).toBe(false); // body did not contain "deleted"
    expect(checks[3].met).toBe(false);
  }, 30_000);
});
