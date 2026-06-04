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
let fixture = "";

// A drop zone (NO file input) that reports the dropped file's name + size.
const PAGE = `<!doctype html><html><head><title>Upload</title></head><body>
  <div id="zone" tabindex="0" aria-label="Drop files here" style="padding:40px;border:2px dashed #888">Drop here</div>
  <div id="out">none</div>
  <script>
    const z = document.getElementById('zone');
    ['dragenter','dragover'].forEach(t => z.addEventListener(t, e => e.preventDefault()));
    z.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      document.getElementById('out').textContent = f ? (f.name + ':' + f.size) : 'empty';
    });
  </script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-drop-"));
  fixture = path.join(dir, "avatar.png");
  fs.writeFileSync(fixture, Buffer.from("PNGDATA-1234567890")); // 18 bytes
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("drop_file tool", () => {
  it("drops the configured upload file onto a drop zone (no file input)", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir, uploads: [fixture] });
    await s.start();
    await s.goto(base);
    const exec = new ToolExecutor(s);
    const idx = findElementIndex((await s.snapshot()).rendered, (l) => /"Drop files here"/.test(l));

    const res = await exec.execute("drop_file", { index: idx });
    const out = await s.page.locator("#out").textContent();
    await s.close();

    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/Dropped file "avatar\.png"/);
    expect(out).toBe("avatar.png:18"); // the drop handler received the real file
  }, 30_000);

  it("fails clearly when no upload file is configured", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir }); // no uploads
    await s.start();
    await s.goto(base);
    const exec = new ToolExecutor(s);
    const idx = findElementIndex((await s.snapshot()).rendered, (l) => /"Drop files here"/.test(l));
    const res = await exec.execute("drop_file", { index: idx });
    await s.close();
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/No upload file configured/);
  }, 30_000);
});
