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
 * End-to-end plumbing for the iter-106/109/116/117 signals — clipboard capture,
 * transient-toast capture, layout overflow — through the REAL runSpec pipeline,
 * which only unit tests cover otherwise. A wiring regression in the runner's
 * evaluation/report wiring would pass every unit test yet ship broken.
 */

// Clicking Save copies a token, announces a toast, and the page overflows wide.
const APP = `<!doctype html><html><head><title>Save</title></head><body style="margin:0">
  <button id="save" onclick="
    navigator.clipboard.writeText('token-xyz');
    document.cookie = 'cookie_consent=accepted; path=/';
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('auth_token', 'eyJ.signed.jwt');
    document.getElementById('msg').textContent = 'Saved successfully';
    this.textContent = 'Saved';
  ">Save</button>
  <div id="msg" role="status" aria-live="polite"></div>
  <div style="width:1500px;height:10px"></div>
</body></html>`;

let server: http.Server;
let base = "";
let runsDir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(APP)));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-asserts-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(runsDir, { recursive: true, force: true });
});

function makeClients(capture: { prompt?: string }): { llm: LlmClient; judge: LlmClient } {
  const find = (obs: string, re: RegExp) => findElementIndex(obs, (l) => re.test(l));
  // turn 0: click Save; afterwards: done.
  const actor = new CallbackLlm((obs, turn) =>
    turn === 0 && /"Save"/.test(obs)
      ? { tool: "click", input: { index: find(obs, /"Save"/) }, thought: "save" }
      : { tool: "done", input: { outcome: "success", notes: "saved" } }
  );
  const judge = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
    submit_verdict: (o: { prompt: unknown }) => {
      capture.prompt = promptText(o.prompt);
      return {
        decision: "pass",
        confidence: 0.9,
        summary: "Saved.",
        checkpoints: [{ id: 1, status: "met", evidence: "the toast confirmed it" }],
        issues: [],
      };
    },
  });
  return { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient };
}

describe("runSpec: clipboard / toast / layout signals end-to-end", () => {
  it("captures and evaluates clipboard + toast, flags layout overflow, all on the report", async () => {
    const capture: { prompt?: string } = {};
    const report = await runSpec(
      {
        title: "Save copies a token and confirms",
        task: "Click Save",
        intent: "a token is copied and a confirmation toast appears",
        criteria: ["the save completes"],
        app: { url: base },
        expectClipboard: "token-xyz",
        expectToast: "Saved",
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 8 }, clients: makeClients(capture) }
    );

    // Clipboard assertion evaluated against the real captured writeText().
    expect(report.clipboardCheck).toEqual({ expected: "token-xyz", met: true });
    // Toast assertion evaluated against the captured aria-live announcement.
    expect(report.toastCheck).toEqual({ expected: "Saved", met: true });
    expect(report.liveAnnouncements).toContain("Saved successfully");
    // Layout overflow detected (1500px content at the default 1280px viewport).
    expect(report.layout?.horizontalOverflow).toBe(true);
    // …and all surfaced to the judge.
    expect(capture.prompt).toMatch(/CLIPBOARD ASSERTION/);
    expect(capture.prompt).toMatch(/TOAST\/STATUS ASSERTION/);
    expect(capture.prompt).toMatch(/RESPONSIVE LAYOUT/);
    // The deterministic gates agree.
    expect(qaGateFailures([report], ["clipboard", "toast", "layout"])).toHaveLength(1); // only layout
    expect(qaGateFailures([report], ["clipboard", "toast"])).toEqual([]); // both met
  }, 45_000);

  it("reads real cookies + localStorage and evaluates persisted-state assertions", async () => {
    const capture: { prompt?: string } = {};
    const report = await runSpec(
      {
        title: "Save persists consent + theme",
        task: "Click Save",
        intent: "the app persists the consent cookie and the theme preference",
        criteria: ["the save completes"],
        app: { url: base },
        expectState: [
          { scope: "cookie", key: "cookie_consent", value: "accepted" }, // met
          { scope: "localStorage", key: "theme", value: "dark" }, // met
          { scope: "localStorage", key: "auth_token" }, // met (present)
          { scope: "sessionStorage", key: "never_set", absent: true }, // met (absent)
          { scope: "cookie", key: "tracking_id" }, // UNMET — never set
        ],
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 8 }, clients: makeClients(capture) }
    );

    const byKey = Object.fromEntries((report.stateChecks ?? []).map((c) => [`${c.scope}:${c.key}`, c]));
    expect(byKey["cookie:cookie_consent"].met).toBe(true);
    expect(byKey["localStorage:theme"].met).toBe(true);
    expect(byKey["localStorage:auth_token"]).toMatchObject({ present: true, met: true });
    expect(byKey["sessionStorage:never_set"]).toMatchObject({ present: false, met: true });
    expect(byKey["cookie:tracking_id"]).toMatchObject({ present: false, met: false });
    // Surfaced to the judge and gated deterministically (only the missing cookie trips).
    expect(capture.prompt).toMatch(/STATE ASSERTIONS/);
    expect(qaGateFailures([report], ["state"])).toEqual(["Save persists consent + theme: cookie \"tracking_id\" was not set"]);
  }, 45_000);

  it("reconciles a judge 'pass' down to 'fail' when a deterministic assertion is unmet", async () => {
    // The judge is hard-wired to return pass (checkpoint met), but the page
    // never shows this text — objective truth must override the green.
    const report = await runSpec(
      {
        title: "Save shows the receipt",
        task: "Click Save",
        intent: "a receipt number appears",
        criteria: ["the save completes"],
        app: { url: base },
        expectText: ["Receipt #4815"], // never rendered → UNMET
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 6 }, clients: makeClients({}) }
    );
    expect(report.verdict.decision).toBe("fail"); // reconciled from the judge's pass
    expect(report.verdict.confidence).toBeLessThanOrEqual(0.5);
    expect(report.verdict.issues[0]).toMatch(/reconciled pass→fail/);
    expect(report.verdict.issues[0]).toMatch(/deterministic assertion/);
    expect(report.textChecks?.[0]).toMatchObject({ text: "Receipt #4815", met: false });
  }, 45_000);

  it("leaves a judge 'pass' alone when the deterministic assertion is met", async () => {
    const report = await runSpec(
      {
        title: "Save confirms",
        task: "Click Save",
        intent: "a confirmation appears",
        criteria: ["the save completes"],
        app: { url: base },
        expectText: ["Saved successfully"], // the page DOES show this
      },
      { config: { apiKey: "test-key", runsDir, maxSteps: 6 }, clients: makeClients({}) }
    );
    expect(report.verdict.decision).toBe("pass");
    expect(report.textChecks?.[0]).toMatchObject({ met: true });
  }, 45_000);

  it("degrades to an inconclusive REPORT (not a crash) when the planner model fails", async () => {
    // No `criteria` → the planner runs; makeClients has no submit_plan handler,
    // so makePlan throws — the run must still produce a full report.
    const report = await runSpec(
      { title: "Planner fails", task: "do x", intent: "y", app: { url: base } },
      { config: { apiKey: "test-key", runsDir, maxSteps: 4 }, clients: makeClients({}) }
    );
    expect(report.verdict.decision).toBe("inconclusive");
    expect(report.triage?.category).toBe("inconclusive");
    expect(report.verdict.summary).toMatch(/plan could not be generated/i);
    expect(report.steps).toHaveLength(0);
    // A report.json was actually written (the whole point — not just trace.zip).
    expect(fs.existsSync(path.join(report.runDir, "report.json"))).toBe(true);
  }, 30_000);

  it("resolves per-case template vars (options.vars) into the rendered spec", async () => {
    const report = await runSpec(
      {
        title: "Pay with {{card}}",
        task: "Enter card {{card}} and click Save",
        intent: "payment {{outcome}}",
        criteria: ["the save completes"],
        app: { url: base },
        expectText: ["{{outcome}}"],
      },
      {
        config: { apiKey: "test-key", runsDir, maxSteps: 4 },
        clients: makeClients({}),
        vars: { card: "4111", outcome: "Saved" },
      }
    );
    // The rendered spec carried the case values (not the raw {{tokens}}).
    expect(report.spec.task).toBe("Enter card 4111 and click Save");
    expect(report.spec.title).toBe("Pay with 4111");
    expect(report.textChecks?.[0]).toMatchObject({ text: "Saved" }); // {{outcome}} resolved before evaluation
  }, 45_000);
});
