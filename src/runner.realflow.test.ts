import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSpec } from "./runner.js";
import { CallbackLlm, findElementIndex } from "./testing/callback-llm.js";
import type { LlmClient } from "./llm/anthropic.js";

/**
 * The milestone test: drive the REAL runSpec pipeline (plan → agent loop →
 * judge → report) through a realistic SPA that mimics a SaaS API-key flow,
 * using CallbackLlm (observation-aware) so no API key is needed. Exercises all
 * the perception/security hardening (modal awareness, loading wait, row
 * context, secret scrub + screenshot suppression) composed in one run.
 */

const SECRET = "tok_9528d50a09da3f75be1fb07928c1466c0ec390955272cc08";

// A single-page app: a brief Loading… state, login, an API-keys table, a create
// modal that reveals a one-time secret, and a revoke confirmation modal.
const APP = `<!doctype html><html lang="en"><head><title>Keys</title></head><body>
<div id="app">Loading…</div>
<script>
const keys = [{name:"prod", state:"active"},{name:"ci", state:"active"}];
let view = "login";
function render(){
  const a = document.getElementById('app');
  if(view==="login"){
    a.innerHTML = '<h1>Sign in</h1><input id="email" placeholder="Email"><input id="pw" type="password" placeholder="Password"><button onclick="view=\\'keys\\';render()">Sign in</button>';
  } else if(view==="keys"){
    a.innerHTML = '<h1>API keys</h1><button onclick="view=\\'create\\';render()">+ New key</button><table><tbody>'+
      keys.map((k,i)=>'<tr><td>'+k.name+'</td><td>'+k.state+'</td><td>'+(k.state==="active"?'<button onclick="confirmIdx='+i+';view=\\'confirm\\';render()">Revoke</button>':'')+'</td></tr>').join('')+'</tbody></table>';
  } else if(view==="create"){
    a.innerHTML = '<div role="dialog"><h2>New key</h2><input id="kn" placeholder="Key name"><button onclick="createKey()">Create key</button><button onclick="view=\\'keys\\';render()">Cancel</button></div>';
  } else if(view==="secret"){
    a.innerHTML = '<div role="dialog"><h2>Key created</h2><p>Copy it now — shown only once: ${SECRET}</p><button onclick="view=\\'keys\\';render()">Close</button></div>';
  } else if(view==="confirm"){
    a.innerHTML = '<div role="dialog"><h2>Revoke key?</h2><p>This cannot be undone.</p><button onclick="doRevoke()">Revoke</button><button onclick="view=\\'keys\\';render()">Cancel</button></div>';
  }
}
let confirmIdx = -1;
function createKey(){ const n = document.getElementById('kn').value || 'unnamed'; keys.push({name:n, state:"active"}); view="secret"; render(); }
function doRevoke(){ keys[confirmIdx].state="revoked"; view="keys"; render(); }
setTimeout(render, 350); // brief loading state -> tests waitForContent
</script></body></html>`;

let server: http.Server;
let base = "";
let runsDir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(APP)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-realflow-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(runsDir, { recursive: true, force: true });
});

/** Observation-aware driver: reads each snapshot and picks the next action by name. */
function makeClients(): { llm: LlmClient; judge: LlmClient } {
  const find = (obs: string, re: RegExp) => findElementIndex(obs, (l) => re.test(l));
  const lineFor = (obs: string, re: RegExp) =>
    obs.split("\n").find((l) => /^\[\d+\]/.test(l.trim()) && re.test(l)) ?? "";
  const KEY = "qa-key";

  const actor = new CallbackLlm(
    (obs) => {
      // LOGIN — fill email, then password, then submit (reads input values).
      // (The indexer renders a placeholder as the element's NAME: `"Email"`.)
      if (/<input[^>]*> "Email"/.test(obs)) {
        if (!/value=/.test(lineFor(obs, /"Email"/)))
          return { tool: "type", input: { index: find(obs, /"Email"/), text: "qa@example.com" }, thought: "email" };
        if (!/value=/.test(lineFor(obs, /type=password/)))
          return { tool: "type", input: { index: find(obs, /type=password/), text: "secret" }, thought: "password" };
        return { tool: "click", input: { index: find(obs, /"Sign in"/) }, thought: "sign in" };
      }
      // SECRET modal — close it (after the create).
      if (/shown only once/.test(obs)) return { tool: "click", input: { index: find(obs, /"Close"/) }, thought: "close secret modal" };
      // CREATE modal — name the key, then create.
      if (/"Key name"/.test(obs)) {
        if (!/value=/.test(lineFor(obs, /Key name/)))
          return { tool: "type", input: { index: find(obs, /Key name/), text: KEY }, thought: "name the key" };
        return { tool: "click", input: { index: find(obs, /"Create key"/) }, thought: "create" };
      }
      // REVOKE confirm modal — confirm via the in-dialog Revoke.
      if (/Revoke key\?|cannot be undone/.test(obs))
        return { tool: "click", input: { index: find(obs, /"Revoke".*\(in dialog\)/) }, thought: "confirm revoke" };
      // KEYS table: our key now revoked -> done.
      if (new RegExp(`${KEY}.*revoked|revoked.*${KEY}`).test(obs.replace(/\n/g, " ")))
        return { tool: "done", input: { outcome: "success", notes: `${KEY} created then revoked` } };
      // KEYS table: revoke OUR key's row (disambiguated by row context).
      if (new RegExp(`"Revoke".*\\(in "${KEY}`).test(obs))
        return { tool: "click", input: { index: find(obs, new RegExp(`"Revoke".*\\(in "${KEY}`)) }, thought: "revoke our key" };
      // KEYS view: open the create modal.
      if (/"\+ New key"/.test(obs)) return { tool: "click", input: { index: find(obs, /"\+ New key"/) }, thought: "new key" };
      return { tool: "done", input: { outcome: "blocked", notes: "lost the thread" } };
    },
    { submit_plan: { goal: "create and revoke an api key", checkpoints: ["the key is created then shows revoked"] } }
  );

  const judge = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
    submit_verdict: (opts: { prompt: unknown }) => {
      const text = String((opts as { prompt: unknown }).prompt);
      const ok = /revoked/.test(text) && /qa-key/.test(text);
      return {
        decision: ok ? "pass" : "fail",
        confidence: 0.9,
        summary: ok ? "The key was created and then revoked." : "Did not reach the revoked state.",
        checkpoints: [{ id: 1, status: ok ? "met" : "unmet", evidence: "key row shows revoked" }],
        issues: [],
      };
    },
  });
  return { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient };
}

describe("real-flow pipeline: create + revoke an API key (CallbackLlm, no key)", () => {
  it("drives login → create (modal, secret) → revoke (confirm modal) → revoked, with full reporting", async () => {
    const report = await runSpec(
      {
        title: "Create and revoke an API key",
        task: "Sign in, create a key, then revoke it.",
        intent: "The created key first shows active, then after revoking shows revoked.",
        app: { url: base, auth: { username: "qa@example.com", password: "secret" } },
      },
      {
        config: { apiKey: "test-key", runsDir, maxSteps: 20 },
        clients: makeClients(),
      }
    );

    // The whole flow completed through the real pipeline.
    expect(report.verdict.decision).toBe("pass");
    // Modal awareness fired (the revoke-confirm dialog was recognized).
    expect(report.steps.some((s) => /confirm revoke/i.test(s.thought ?? ""))).toBe(true);
    // The app-revealed secret never leaked into any report field (scrub + suppress).
    expect(JSON.stringify(report)).not.toContain(SECRET);
    // Reports were written.
    for (const f of ["report.json", "report.html", "trace.html"]) {
      expect(fs.existsSync(path.join(report.runDir, f)), f).toBe(true);
      expect(fs.readFileSync(path.join(report.runDir, f), "utf8")).not.toContain(SECRET);
    }
  }, 45_000);
});
