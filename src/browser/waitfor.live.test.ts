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

// "Saving…" shows on click, then is removed after 400ms; "Done!" appears.
const PAGE = `<!doctype html><html><head><title>Save</title></head><body>
  <button id="go" onclick="document.getElementById('st').textContent='Saving…';
    setTimeout(()=>{document.getElementById('st').textContent='Done!';},400)">Go</button>
  <div id="st">idle</div>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-wait-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("wait_for tool", () => {
  it("waits for text to disappear (gone=true) and to appear", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const exec = new ToolExecutor(s);
    // Trigger the transient "Saving…" → "Done!" sequence.
    await s.page.locator("#go").click();

    const gone = await exec.execute("wait_for", { text: "Saving", gone: true });
    expect(gone.ok).toBe(true);
    expect(gone.summary).toMatch(/is gone/);
    expect(await s.page.locator("#st").textContent()).toBe("Done!");

    const appeared = await exec.execute("wait_for", { text: "Done!" });
    expect(appeared.ok).toBe(true);
    expect(appeared.summary).toMatch(/appeared/);
    await s.close();
  }, 30_000);

  it("times out (ok:false) with a clear message when text never disappears", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base); // "idle" is permanent
    const exec = new ToolExecutor(s);
    const res = await exec.execute("wait_for", { text: "idle", gone: true });
    await s.close();
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/still present/);
  }, 30_000);
});
