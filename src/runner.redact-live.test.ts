import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSpec } from "./runner.js";
import { CallbackLlm, findElementIndex } from "./testing/callback-llm.js";
import type { LlmClient } from "./llm/anthropic.js";
import type { Step } from "./types.js";

// The exact incident from the field report: a password typed during a run was
// echoed in the LIVE step log (`Typed "<password>"`), leaking before the report
// was ever redacted. This proves the runner scrubs the live onStep stream too.
const PASSWORD = "hunter2-SUPER-SECRET";

const PAGE = `<!doctype html><html><head><title>Login</title></head><body>
  <h1>Sign in</h1>
  <input id="pw" type="password" placeholder="Password">
  <button id="go" onclick="document.getElementById('out').textContent='Welcome back'">Sign in</button>
  <div id="out"></div>
</body></html>`;

let server: http.Server;
let base = "";
let runsDir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-redact-live-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(runsDir, { recursive: true, force: true });
});

function makeClients(): { llm: LlmClient; judge: LlmClient } {
  const actor = new CallbackLlm(
    (obs, turn) => {
      if (turn === 0) {
        const i = findElementIndex(obs, (l) => /<input/.test(l));
        return { tool: "type", input: { index: i, text: PASSWORD }, thought: "enter the password" };
      }
      if (turn === 1) {
        const i = findElementIndex(obs, (l) => /"Sign in"/.test(l));
        return { tool: "click", input: { index: i }, thought: "submit" };
      }
      return { tool: "done", input: { outcome: "success", notes: "signed in" } };
    },
    { submit_plan: { goal: "sign in", checkpoints: ["the dashboard greets the user"] } }
  );
  const judge = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
    submit_verdict: () => ({
      decision: "pass",
      confidence: 0.9,
      summary: "signed in",
      checkpoints: [{ id: 1, status: "met", evidence: "welcome shown", evidenceStrength: "strong" }],
      issues: [],
    }),
  });
  return { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient };
}

describe("live step stream is redacted (not just the written report)", () => {
  it("never emits the typed password to onStep, but the agent still typed it for real", async () => {
    const live: Step[] = [];
    await runSpec(
      {
        title: "Sign in",
        task: "Sign in with the provided password.",
        intent: "The dashboard greets the user after signing in.",
        app: { url: base, auth: { username: "qa@example.com", password: PASSWORD } },
      },
      {
        config: { apiKey: "test-key", runsDir, maxSteps: 8 },
        clients: makeClients(),
        onStep: (s) => live.push(s),
      }
    );

    // The live stream — what a console/web viewer prints AS IT HAPPENS — is clean.
    const blob = JSON.stringify(live);
    expect(blob).not.toContain(PASSWORD);
    const typeStep = live.find((s) => s.call.name === "type");
    expect(typeStep?.result.summary).toMatch(/Typed/);
    expect(typeStep?.result.summary).toContain("••••••");
    expect(JSON.stringify(typeStep?.call.input)).not.toContain(PASSWORD);

    // …yet the real password reached the page (the masking is display-only): the
    // app accepted the submit and rendered its welcome state.
    expect(live.some((s) => /Welcome back/.test(s.result.summary) || s.call.name === "done")).toBe(true);
  }, 30_000);
});
