import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";
import { ToolExecutor } from "./tools.js";
import { findElementIndex } from "../testing/callback-llm.js";

// A page with a disabled submit (enabled only once the input is filled), a
// read-only field, a native <select>, and a custom ARIA "dropdown".
const PAGE = `<!doctype html><html><head><title>Form</title></head><body>
<input id="name" placeholder="Name" oninput="document.getElementById('go').disabled = !this.value">
<button id="go" disabled onclick="document.getElementById('out').textContent='SUBMITTED'">Submit</button>
<input id="ro" value="locked" readonly placeholder="Readonly">
<select id="color"><option>Red</option><option>Green</option><option>Blue</option></select>
<div id="combo" role="button" tabindex="0">Pick a fruit</div>
<div id="out">idle</div>
</body></html>`;

let server: http.Server;
let base = "";
let dir = "";
let session: BrowserSession;
let exec: ToolExecutor;

async function idx(re: RegExp): Promise<number> {
  const snap = await session.snapshot();
  return findElementIndex(snap.rendered, (l) => re.test(l));
}

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-exec-"));
  session = new BrowserSession({ headed: false, actionTimeoutMs: 8000, artifactsDir: dir });
  await session.start();
  await session.goto(base);
  exec = new ToolExecutor(session);
});
afterAll(async () => {
  await session.close();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ToolExecutor actionability fast-fails", () => {
  it("clicking a disabled button fails fast with a precondition hint (no 10s timeout)", async () => {
    const t0 = Date.now();
    const res = await exec.execute("click", { index: await idx(/"Submit"/) });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/disabled/i);
    expect(res.summary).toMatch(/precondition|required field|unmet/i);
    expect(elapsed).toBeLessThan(4000); // proves we did NOT wait out the action timeout
  }, 15_000);

  it("typing into a read-only input fails fast and says read-only", async () => {
    const res = await exec.execute("type", { index: await idx(/Readonly|"Readonly"/), text: "x" });
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/read-only/i);
  }, 15_000);

  it("once the precondition is met, the same control becomes clickable", async () => {
    const typed = await exec.execute("type", { index: await idx(/"Name"|placeholder="Name"/), text: "Ada" });
    expect(typed.ok).toBe(true);
    const clicked = await exec.execute("click", { index: await idx(/"Submit"/) });
    expect(clicked.ok).toBe(true);
    expect(await session.page.locator("#out").textContent()).toBe("SUBMITTED");
  }, 15_000);

  it("selecting a missing option lists the real available options", async () => {
    const res = await exec.execute("select", { index: await idx(/<select|role=combobox/), value: "Purple" });
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/Red/);
    expect(res.summary).toMatch(/Green/);
    expect(res.summary).toMatch(/Blue/);
  }, 15_000);

  it("select on a non-native (ARIA) control explains it must be clicked open", async () => {
    const res = await exec.execute("select", { index: await idx(/"Pick a fruit"/), value: "Apple" });
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/custom|ARIA|click it to open/i);
  }, 15_000);
});
