import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "./loop.js";
import { BrowserSession } from "../browser/session.js";
import { CallbackLlm, findElementIndex } from "../testing/callback-llm.js";
import type { LlmClient } from "../llm/anthropic.js";

let server: http.Server;
let base = "";
let dir = "";

const PAGE = `<!doctype html><html><head><title>Form</title></head><body>
  <h1>Contact</h1>
  <input id="name" placeholder="Your name">
  <button id="save" onclick="document.getElementById('out').textContent='SAVED '+document.getElementById('name').value">Save</button>
  <div id="out">empty</div>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-cb-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent loop driven by observation-aware callback", () => {
  it("finds elements by name in the observation and completes the task", async () => {
    const session = new BrowserSession({ headed: false, actionTimeoutMs: 8000, artifactsDir: dir });
    await session.start();
    await session.goto(base);

    // The decide callback READS the rendered observation and picks elements by
    // their visible name — no hardcoded indices.
    const llm = new CallbackLlm((obs, turn) => {
      if (turn === 0) {
        const i = findElementIndex(obs, (l) => /placeholder="Your name"|<input/.test(l));
        return { tool: "type", input: { index: i, text: "Ada" }, thought: "fill the name field" };
      }
      if (turn === 1) {
        const i = findElementIndex(obs, (l) => /"Save"/.test(l));
        return { tool: "click", input: { index: i }, thought: "save" };
      }
      return { tool: "done", input: { outcome: "success", notes: "saved Ada" } };
    });

    const run = await runAgent({
      llm: llm as unknown as LlmClient,
      session,
      plan: { goal: "save a contact", checkpoints: [] },
      maxSteps: 6,
    });
    const saved = await session.page.locator("#out").textContent();
    await session.close();

    expect(run.done?.outcome).toBe("success");
    expect(saved).toBe("SAVED Ada"); // the real browser executed the callback-chosen actions
    expect(run.steps.map((s) => s.call.name)).toEqual(["type", "click", "done"]);
  }, 30_000);

  it("ends gracefully as 'blocked' when the model API call fails terminally", async () => {
    const session = new BrowserSession({ headed: false, actionTimeoutMs: 8000, artifactsDir: dir });
    await session.start();
    await session.goto(base);
    // A client whose every turn throws (API sustained-down after retries).
    const boom = {
      turn: async () => {
        throw Object.assign(new Error("Overloaded"), { status: 529 });
      },
    } as unknown as LlmClient;

    const run = await runAgent({
      llm: boom,
      session,
      plan: { goal: "save a contact", checkpoints: [] },
      maxSteps: 6,
    });
    await session.close();

    // No crash — a graceful blocked result the judge/report path can use.
    expect(run.done?.outcome).toBe("blocked");
    expect(run.done?.notes).toMatch(/Model API call failed after retries/);
    expect(run.exhausted).toBe(false);
    expect(run.steps).toEqual([]); // it failed before taking any action
  }, 30_000);

  it("halts (doesn't burn the budget) when the model refuses to act for several turns", async () => {
    const session = new BrowserSession({ headed: false, actionTimeoutMs: 8000, artifactsDir: dir });
    await session.start();
    await session.goto(base);
    // A client that always "thinks out loud" and never calls a tool.
    let calls = 0;
    const inert = {
      turn: async () => {
        calls++;
        return {
          text: "Let me think about this…",
          toolUses: [],
          raw: [{ type: "text", text: "Let me think…" }],
          stopReason: "end_turn",
          usage: { input: 1, output: 1 },
        };
      },
    } as unknown as LlmClient;

    const run = await runAgent({
      llm: inert,
      session,
      plan: { goal: "save a contact", checkpoints: [] },
      maxSteps: 12,
    });
    await session.close();

    expect(run.done?.outcome).toBe("blocked");
    expect(run.done?.notes).toMatch(/without taking any action/);
    expect(calls).toBe(3); // stopped at MAX_NO_ACTION, not all 12 steps
    expect(run.steps).toEqual([]);
  }, 30_000);
});
