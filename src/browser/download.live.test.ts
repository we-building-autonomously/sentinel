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

// A page with a link that forces a CSV download (Content-Disposition: attachment).
const PAGE = `<!doctype html><html><head><title>Export</title></head><body>
  <h1>Reports</h1>
  <a id="dl" href="/report.csv" download="report.csv">Export CSV</a>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/report.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' });
      res.end("name,score\nAda,99\nGrace,98\n");
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-dl-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("download capture", () => {
  it("saves a triggered download, records it, and surfaces a note to the agent", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const snap = await s.snapshot();
    const exec = new ToolExecutor(s);
    const idx = findElementIndex(snap.rendered, (l) => /Export CSV/.test(l));
    await exec.execute("click", { index: idx });
    // The download lands asynchronously after the click; give the handler a beat.
    await s.page.waitForTimeout(500);

    const notes = s.drainDownloads();
    const drainedAgain = s.drainDownloads(); // draining is one-shot
    const records = s.downloadRecords();
    await s.close();

    expect(records).toHaveLength(1);
    expect(records[0].filename).toBe("report.csv");
    expect(records[0].bytes).toBeGreaterThan(0);
    expect(records[0].error).toBeUndefined();
    // The file was actually written into the artifacts dir.
    expect(fs.existsSync(path.join(dir, records[0].path!))).toBe(true);
    // The agent gets told a file downloaded (so it can verify the export).
    expect(notes.join(" ")).toMatch(/downloaded file "report\.csv"/);
    expect(drainedAgain).toEqual([]); // already drained
  }, 30_000);
});
