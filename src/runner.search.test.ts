import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSpec } from "./runner.js";
import { CallbackLlm, findElementIndex } from "./testing/callback-llm.js";
import type { LlmClient } from "./llm/anthropic.js";

/**
 * A search → ASYNC results → select flow. Unlike the realflow test (synchronous
 * view swaps), results arrive after a delay behind an aria-busy "Searching…"
 * state — so this stresses the loading-wait path for non-navigation content
 * updates: the agent must see the results on its snapshot AFTER the search,
 * without explicitly waiting.
 */
const APP = `<!doctype html><html lang="en"><head><title>Search</title></head><body>
  <h1>Documents</h1>
  <input id="q" placeholder="Search">
  <button id="go" onclick="search()">Search</button>
  <div id="results">Type a query and search.</div>
  <div id="picked">none</div>
  <script>
    function search(){
      const r = document.getElementById('results');
      r.setAttribute('aria-busy','true');
      r.textContent = 'Searching…';
      setTimeout(() => {
        r.removeAttribute('aria-busy');
        r.innerHTML = '<ul>' +
          ['Report Q3','Report Q2','Invoice 1041'].map(t =>
            '<li><button onclick="document.getElementById(\\'picked\\').textContent=\\'Selected: '+t+'\\'">'+t+'</button></li>').join('') +
          '</ul>';
      }, 350); // async results behind an aria-busy state
    }
  </script>
</body></html>`;

let server: http.Server;
let base = "";
let runsDir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(APP)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-search-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(runsDir, { recursive: true, force: true });
});

function makeClients(): { llm: LlmClient; judge: LlmClient } {
  const find = (obs: string, re: RegExp) => findElementIndex(obs, (l) => re.test(l));
  const lineFor = (obs: string, re: RegExp) =>
    obs.split("\n").find((l) => /^\[\d+\]/.test(l.trim()) && re.test(l)) ?? "";

  const actor = new CallbackLlm(
    (obs) => {
      // The chosen result already selected -> done.
      if (/Selected: Report Q3/.test(obs)) return { tool: "done", input: { outcome: "success", notes: "selected Report Q3" } };
      // Results present -> click the target. (Only reachable if the async results
      // actually appeared on the post-search snapshot — the thing under test.)
      if (/"Report Q3"/.test(obs)) return { tool: "click", input: { index: find(obs, /"Report Q3"/) }, thought: "pick result" };
      // Query not yet entered -> type it into the text input.
      if (/<input[^>]*type=text/.test(obs) && !/value=/.test(lineFor(obs, /type=text/)))
        return { tool: "type", input: { index: find(obs, /type=text/), text: "report" }, thought: "type query" };
      // Query entered -> run the search via the BUTTON. (Both the input and the
      // button surface the accessible name "Search" — the input from its
      // placeholder — so the click must target `<button>` specifically.)
      if (/<button[^>]*> "Search"/.test(obs))
        return { tool: "click", input: { index: find(obs, /<button[^>]*> "Search"/) }, thought: "search" };
      return { tool: "done", input: { outcome: "blocked", notes: "stuck" } };
    },
    { submit_plan: { goal: "search and select a document", checkpoints: ["the chosen document is selected"] } }
  );
  const judge = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
    submit_verdict: (o: { prompt: unknown }) => {
      const ok = /Selected: Report Q3/.test(String(o.prompt));
      return {
        decision: ok ? "pass" : "fail",
        confidence: 0.9,
        summary: ok ? "Searched and selected Report Q3." : "Did not select the result.",
        checkpoints: [{ id: 1, status: ok ? "met" : "unmet", evidence: "picked shows the selection" }],
        issues: [],
      };
    },
  });
  return { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient };
}

describe("real-flow: search → async results → select (CallbackLlm)", () => {
  it("sees async results after the search (loading-wait) and selects one", async () => {
    const report = await runSpec(
      {
        title: "Search and open a document",
        task: 'Search for "report" and open "Report Q3".',
        intent: 'After searching, the "Report Q3" document is selected.',
        app: { url: base },
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 12 }, clients: makeClients() }
    );

    expect(report.verdict.decision).toBe("pass");
    // Proof the agent acted on the async results (clicked one), not a stale snapshot.
    expect(report.steps.some((s) => /pick result/i.test(s.thought ?? ""))).toBe(true);
    expect(report.steps.map((s) => s.call.name)).toContain("click");
  }, 30_000);
});
