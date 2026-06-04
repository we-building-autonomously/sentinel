import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

// A "Save" button shows a toast in a role=status region, then REMOVES it 200ms later.
const PAGE = `<!doctype html><html><head><title>Save</title></head><body>
  <button id="save" onclick="toast()">Save</button>
  <div id="region" role="status" aria-live="polite"></div>
  <script>
    function toast(){
      const r = document.getElementById('region');
      r.textContent = 'Saved successfully';
      setTimeout(() => { r.textContent = ''; }, 200); // vanishes
    }
  </script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-live-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ARIA live-region (toast) capture", () => {
  it("records a transient toast even after it has vanished", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    await s.page.locator("#save").click();
    await s.page.waitForTimeout(500); // let the toast appear AND vanish

    // The region is now empty…
    expect(await s.page.locator("#region").textContent()).toBe("");
    // …but the announcement was captured when it appeared.
    const live = await s.liveAnnouncements();
    await s.close();
    expect(live).toContain("Saved successfully");
  }, 30_000);
});
