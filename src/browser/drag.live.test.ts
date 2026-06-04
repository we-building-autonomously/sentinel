import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";
import { ToolExecutor } from "./tools.js";
import { findElementIndex } from "../testing/callback-llm.js";

let server: http.Server;
let base = "";
let dir = "";

// HTML5 drag-and-drop: drop the card onto the zone and the status updates.
const PAGE = `<!doctype html><html><head><title>Board</title></head><body>
  <div id="card" draggable="true" style="padding:20px;border:1px solid #888">Card</div>
  <div id="zone" tabindex="0" style="padding:40px;border:2px dashed #888;margin-top:20px">Drop zone</div>
  <div id="status">empty</div>
  <script>
    const card = document.getElementById('card'), zone = document.getElementById('zone');
    card.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'card'));
    zone.addEventListener('dragover', e => e.preventDefault());
    zone.addEventListener('drop', e => { e.preventDefault(); document.getElementById('status').textContent = 'DROPPED'; });
  </script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-drag-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("drag tool", () => {
  it("drags one element onto another and fires the HTML5 drop", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    const exec = new ToolExecutor(s);
    const from = findElementIndex(snap.rendered, (l) => /Card/.test(l));
    const to = findElementIndex(snap.rendered, (l) => /Drop zone/.test(l));
    // A draggable="true" element must be indexed, or the agent can't pick it up.
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThanOrEqual(0);

    const res = await exec.execute("drag", { from, to });
    const status = await s.page.locator("#status").textContent();
    await s.close();

    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/Dragged .* onto/);
    expect(status).toBe("DROPPED");
  }, 30_000);
});
