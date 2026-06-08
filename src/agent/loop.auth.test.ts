import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "./loop.js";
import { BrowserSession } from "../browser/session.js";
import { CallbackLlm, findElementIndex } from "../testing/callback-llm.js";
import type { LlmClient } from "../llm/anthropic.js";

// A login form that rejects every submission with "Invalid credentials" — the
// shape that, before the guard, let the agent re-submit until Auth0's
// brute-force protection locked the account.
const PAGE = `<!doctype html><html><head><title>Login</title></head><body>
  <h1>Sign in</h1>
  <input id="pw" type="password" placeholder="Password">
  <button id="go" onclick="document.getElementById('err').textContent='Invalid credentials'">Sign in</button>
  <div id="err"></div>
</body></html>`;

let server: http.Server;
let base = "";
let dir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-auth-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An agent that types a password once, then keeps clicking "Sign in" — i.e. it
 *  WOULD retry the rejected credential indefinitely if nothing stopped it. */
function retryingActor(): LlmClient {
  return new CallbackLlm((obs, turn) => {
    if (turn === 0) {
      const i = findElementIndex(obs, (l) => /<input/.test(l));
      return { tool: "type", input: { index: i, text: "wrong-pass" }, thought: "enter password" };
    }
    const i = findElementIndex(obs, (l) => /"Sign in"/.test(l));
    return { tool: "click", input: { index: i }, thought: "submit login" };
  }) as unknown as LlmClient;
}

describe("agent loop — auth-failure backstop", () => {
  it("stops immediately as 'blocked' when the app rejects the login (no retry)", async () => {
    const session = new BrowserSession({ headed: false, actionTimeoutMs: 8000, artifactsDir: dir });
    await session.start();
    await session.goto(base);

    const run = await runAgent({
      llm: retryingActor(),
      session,
      plan: { goal: "log in", checkpoints: [] },
      maxSteps: 10,
      stopOnAuthFailure: true,
    });
    await session.close();

    expect(run.done?.outcome).toBe("blocked");
    expect(run.done?.notes).toMatch(/Login was rejected/);
    expect(run.done?.notes).toMatch(/without retrying/);
    // type + the single submit that surfaced the rejection — it did NOT re-submit.
    expect(run.steps.map((s) => s.call.name)).toEqual(["type", "click"]);
  }, 30_000);

  it("does NOT stop on the rejection when the test's intent is to verify it (stopOnAuthFailure=false)", async () => {
    const session = new BrowserSession({ headed: false, actionTimeoutMs: 8000, artifactsDir: dir });
    await session.start();
    await session.goto(base);

    const run = await runAgent({
      llm: retryingActor(),
      session,
      plan: { goal: "verify a bad login is rejected", checkpoints: [] },
      maxSteps: 6,
      stopOnAuthFailure: false,
    });
    await session.close();

    // It was allowed to proceed past the rejection — so it re-submitted, and any
    // halt came from the generic no-progress guard, NOT the auth backstop.
    expect(run.done?.notes ?? "").not.toMatch(/Login was rejected/);
    expect(run.steps.length).toBeGreaterThan(2);
  }, 30_000);
});
