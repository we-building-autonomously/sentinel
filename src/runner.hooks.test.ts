import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSpec } from "./runner.js";
import { CallbackLlm } from "./testing/callback-llm.js";
import type { LlmClient } from "./llm/anthropic.js";

/**
 * End-to-end: setup/teardown HTTP hooks fire around the REAL runSpec pipeline —
 * setup before the browser, teardown after — and a failed setup blocks the run
 * without launching the browser.
 */

const APP = `<!doctype html><html><head><title>App</title></head><body><h1>Ready</h1></body></html>`;

let server: http.Server;
let base = "";
let runsDir = "";
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/setup-fail") {
      res.writeHead(500).end("nope");
    } else if (req.url?.startsWith("/api/")) {
      res.writeHead(204).end();
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(APP);
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-hooks-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(runsDir, { recursive: true, force: true });
});

// An actor that immediately reports success, and a judge that passes.
function clients(): { llm: LlmClient; judge: LlmClient } {
  const actor = new CallbackLlm(() => ({ tool: "done", input: { outcome: "success", notes: "ok" } }));
  const judge = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
    submit_verdict: () => ({ decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [{ id: 1, status: "met", evidence: "e" }], issues: [] }),
  });
  return { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient };
}

describe("runSpec setup/teardown hooks", () => {
  it("fires setup before the run and teardown after, recording both on the report", async () => {
    hits = [];
    const report = await runSpec(
      {
        title: "Checkout from a clean cart",
        task: "do nothing",
        intent: "x",
        criteria: ["ok"],
        app: { url: base },
        setup: [{ method: "DELETE", url: `${base}api/cart` }],
        teardown: [{ method: "POST", url: `${base}api/cleanup`, body: "{}" }],
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 4 }, clients: clients() }
    );

    expect(report.hooks?.setup?.[0]).toMatchObject({ method: "DELETE", ok: true, status: 204 });
    expect(report.hooks?.teardown?.[0]).toMatchObject({ method: "POST", ok: true, status: 204 });
    // Ordering: setup hit before the page load, teardown after.
    const setupIdx = hits.findIndex((h) => h.includes("/api/cart"));
    const pageIdx = hits.findIndex((h) => h === "GET /");
    const teardownIdx = hits.findIndex((h) => h.includes("/api/cleanup"));
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeLessThan(pageIdx);
    expect(teardownIdx).toBeGreaterThan(pageIdx);
    expect(report.verdict.decision).toBe("pass");
  }, 45_000);

  it("blocks the run (no browser) when a setup hook fails", async () => {
    hits = [];
    const report = await runSpec(
      {
        title: "Needs seeded data",
        task: "do nothing",
        intent: "x",
        criteria: ["ok"],
        app: { url: base },
        setup: [{ method: "POST", url: `${base}setup-fail` }],
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 4 }, clients: clients() }
    );

    expect(report.verdict.decision).toBe("inconclusive");
    expect(report.triage?.category).toBe("blocked");
    expect(report.verdict.summary).toMatch(/Setup hook failed/);
    expect(report.hooks?.setup?.[0]).toMatchObject({ ok: false, status: 500 });
    // The browser was never launched: the app page was never requested.
    expect(hits.some((h) => h === "GET /")).toBe(false);
    expect(report.steps).toHaveLength(0);
  }, 30_000);

  it("still runs teardown when setup fails (cleans up partial setup)", async () => {
    hits = [];
    const report = await runSpec(
      {
        title: "Setup fails but teardown cleans up",
        task: "do nothing",
        intent: "x",
        criteria: ["ok"],
        app: { url: base },
        setup: [{ method: "POST", url: `${base}setup-fail` }],
        teardown: [{ method: "POST", url: `${base}api/cleanup` }],
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 4 }, clients: clients() }
    );
    expect(report.triage?.category).toBe("blocked");
    expect(hits.some((h) => h.includes("/api/cleanup"))).toBe(true); // teardown ran
    expect(report.hooks?.teardown?.[0]).toMatchObject({ ok: true });
  }, 30_000);

  it("still runs teardown when the app is unreachable", async () => {
    hits = [];
    const report = await runSpec(
      {
        title: "App down but teardown cleans up",
        task: "do nothing",
        intent: "x",
        criteria: ["ok"],
        app: { url: "http://127.0.0.1:1/" }, // nothing listening → unreachable
        teardown: [{ method: "POST", url: `${base}api/cleanup` }],
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 4 }, clients: clients() }
    );
    expect(report.triage?.category).toBe("app-unavailable");
    expect(hits.some((h) => h.includes("/api/cleanup"))).toBe(true); // teardown ran
    expect(report.hooks?.teardown?.[0]).toMatchObject({ ok: true });
  }, 30_000);
});
