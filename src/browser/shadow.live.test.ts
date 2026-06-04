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

// A web component with an OPEN shadow root containing a real button — and a
// SECOND instance nested inside a light-DOM [role=dialog] (to test composed context).
const PAGE = `<!doctype html><html><head><title>WC</title></head><body>
  <fancy-widget></fancy-widget>
  <div id="out">idle</div>
  <div role="dialog"><fancy-widget id="indlg"></fancy-widget></div>
  <script>
    customElements.define('fancy-widget', class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="go">Shadow Button</button>';
        root.getElementById('go').addEventListener('click', () =>
          document.getElementById('out').textContent = 'SHADOW CLICKED');
      }
    });
  </script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-shadow-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("shadow DOM piercing", () => {
  it("indexes and clicks a button inside an open shadow root", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    const exec = new ToolExecutor(s);

    const idx = findElementIndex(snap.rendered, (l) => /Shadow Button/.test(l));
    expect(idx).toBeGreaterThanOrEqual(0); // the shadow-DOM button is visible to the agent

    const res = await exec.execute("click", { index: idx });
    const out = await s.page.locator("#out").textContent();
    await s.close();

    expect(res.ok).toBe(true);
    expect(out).toBe("SHADOW CLICKED"); // the click resolved through the shadow root
  }, 30_000);

  it("detects an enclosing dialog ACROSS the shadow boundary (composed closest)", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    await s.close();
    // There are two shadow buttons; the one inside the [role=dialog] is marked (in dialog).
    const inDialog = snap.elements.filter((e) => e.name === "Shadow Button" && e.inDialog);
    expect(inDialog.length).toBe(1);
    expect(snap.rendered).toMatch(/Shadow Button.*\(in dialog\)/);
  }, 30_000);
});
