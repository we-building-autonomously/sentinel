import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSpec } from "./runner.js";
import { CallbackLlm, findElementIndex, promptText } from "./testing/callback-llm.js";
import { qaGateFailures } from "./qa-gate.js";
import type { LlmClient } from "./llm/anthropic.js";

/**
 * End-to-end plumbing test for the signals wired into runSpec→judge over many
 * iterations (request expectations, navigation/final-URL, request-log capture)
 * that no other test exercises through the REAL pipeline. Uses CallbackLlm so
 * no API key is needed; `criteria` makes planning deterministic (no planner
 * call). A capturing judge inspects the prompt the runner actually built.
 */

// Clicking Save fires a real POST /api/save; the button then becomes "Saved"
// (a state change on an INTERACTABLE element, so the observation isn't deduped).
const APP = `<!doctype html><html><head><title>Editor</title></head><body>
  <h1>Doc</h1>
  <button id="save" onclick="fetch('/api/save',{method:'POST'}).then(()=>{this.textContent='Saved';this.disabled=true})">Save</button>
</body></html>`;

let server: http.Server;
let base = "";
let runsDir = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/save" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(APP);
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-signals-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(runsDir, { recursive: true, force: true });
});

/** Actor clicks Save then declares done once "Saved" appears. */
function makeClients(capture: { prompt?: string }): { llm: LlmClient; judge: LlmClient } {
  const find = (obs: string, re: RegExp) => findElementIndex(obs, (l) => re.test(l));
  const actor = new CallbackLlm((obs) => {
    if (/"Saved"/.test(obs)) return { tool: "done", input: { outcome: "success", notes: "saved" } };
    if (/"Save"/.test(obs)) return { tool: "click", input: { index: find(obs, /"Save"/) }, thought: "save" };
    return { tool: "done", input: { outcome: "blocked", notes: "stuck" } };
  });
  // Plumbing test — the judge just records the prompt and signs off; the assertions
  // are about the request-check evaluation + what the runner handed the judge.
  const judge = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
    submit_verdict: (o: { prompt: unknown }) => {
      capture.prompt = promptText(o.prompt);
      return {
        decision: "pass",
        confidence: 0.9,
        summary: "Document saved.",
        checkpoints: [{ id: 1, status: "met", evidence: "the Save button now reads Saved" }],
        issues: [],
      };
    },
  });
  return { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient };
}

describe("runSpec signal plumbing (end-to-end, no key)", () => {
  it("evaluates a MET request expectation and feeds it + navigation to the judge", async () => {
    const capture: { prompt?: string } = {};
    const report = await runSpec(
      {
        title: "Save the doc",
        task: "Click Save",
        intent: "the document is saved",
        criteria: ["the page shows Saved"],
        app: { url: base },
        expectRequests: [{ url: "/api/save", method: "POST" }],
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 8 }, clients: makeClients(capture) }
    );

    expect(report.verdict.decision).toBe("pass");
    // The runner evaluated the expectation against the REAL observed request log.
    expect(report.requestChecks).toHaveLength(1);
    expect(report.requestChecks![0]).toMatchObject({ url: "/api/save", met: true });
    expect(report.requestChecks![0].observed).toBeGreaterThanOrEqual(1);
    // …and handed it to the judge, alongside navigation evidence.
    expect(capture.prompt).toMatch(/NETWORK-REQUEST EXPECTATIONS/);
    expect(capture.prompt).toMatch(/\/api\/save/);
    expect(capture.prompt).toMatch(new RegExp(`NAVIGATION: started at ${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    // The deterministic requests gate is satisfied.
    expect(qaGateFailures([report], ["requests"])).toEqual([]);
    // The report records where the run actually ended (final URL + title).
    expect(report.finalUrl).toBe(base);
    expect(report.finalTitle).toBe("Editor");
  }, 45_000);

  it("flags an UNMET request expectation and trips the requests gate", async () => {
    const capture: { prompt?: string } = {};
    const report = await runSpec(
      {
        title: "Save the doc (wrong expectation)",
        task: "Click Save",
        intent: "the document is saved",
        criteria: ["the page shows Saved"],
        app: { url: base },
        expectRequests: [{ url: "/api/publish", method: "POST" }], // never happens
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 8 }, clients: makeClients(capture) }
    );

    expect(report.requestChecks![0]).toMatchObject({ url: "/api/publish", met: false, observed: 0 });
    const gate = qaGateFailures([report], ["requests"]);
    expect(gate).toHaveLength(1);
    expect(gate[0]).toMatch(/unmet request expectation .*\/api\/publish/);
  }, 45_000);

  it("degrades to an inconclusive verdict (with a report) when the judge call fails", async () => {
    // Actor completes the run; the judge model throws terminally.
    const find = (obs: string, re: RegExp) => findElementIndex(obs, (l) => re.test(l));
    const actor = new CallbackLlm((obs) => {
      if (/"Saved"/.test(obs)) return { tool: "done", input: { outcome: "success", notes: "saved" } };
      if (/"Save"/.test(obs)) return { tool: "click", input: { index: find(obs, /"Save"/) }, thought: "save" };
      return { tool: "done", input: { outcome: "blocked", notes: "stuck" } };
    }) as unknown as LlmClient;
    const judge = {
      structured: async () => {
        throw Object.assign(new Error("Overloaded"), { status: 529 });
      },
    } as unknown as LlmClient;

    const report = await runSpec(
      {
        title: "Judge outage",
        task: "Click Save",
        intent: "saved",
        criteria: ["the Save button reads Saved"],
        app: { url: base },
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 8 }, clients: { llm: actor, judge } }
    );

    // No crash: a structured inconclusive result, with the run still recorded.
    expect(report.verdict.decision).toBe("inconclusive");
    expect(report.verdict.summary).toMatch(/judge model call failed/i);
    expect(report.steps.some((s) => s.call.name === "click")).toBe(true);
    // The report was still written to disk.
    expect(fs.existsSync(path.join(report.runDir, "report.json"))).toBe(true);
  }, 45_000);
});
