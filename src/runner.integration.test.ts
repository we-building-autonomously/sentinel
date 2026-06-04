import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSpec } from "./runner.js";
import { ScriptedLlm } from "./testing/scripted-llm.js";
import type { LlmClient } from "./llm/anthropic.js";

/**
 * End-to-end pipeline test: a real Chromium drives a real page, but the LLM is
 * scripted so the run is deterministic and needs no API key. This exercises
 * planner -> agent loop (real tools) -> judge -> report writing as one flow.
 */

let server: http.Server;
let base = "";
let runsDir = "";

const PAGE = `<!doctype html><html><head><title>Notes</title></head><body>
  <h1>My Notes</h1>
  <input id="note" placeholder="New note">
  <button id="add" onclick="add()">Add</button>
  <ul id="list"></ul>
  <script>
    function add(){
      const v=document.getElementById('note').value.trim();
      if(!v) return;
      const li=document.createElement('li'); li.textContent=v;
      document.getElementById('list').appendChild(li);
      document.getElementById('note').value='';
    }
  </script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-itest-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(runsDir, { recursive: true, force: true });
});

function makeClients(verdict: "pass" | "fail", found = true): { llm: LlmClient; judge: LlmClient } {
  // Actor client: runs the planner (submit_plan) and the agent loop + extract.
  const actor = new ScriptedLlm(
    [
      { name: "type", input: { index: 0, text: "Buy milk" }, thought: "Type the note" },
      { name: "click", input: { index: 1 }, thought: "Click Add" },
      { name: "extract", input: { query: "the note list" }, thought: "Verify it appears" },
      { name: "done", input: { outcome: "success", notes: "Note 'Buy milk' is in the list." } },
    ],
    {
      submit_plan: { goal: "Add a note", checkpoints: ["The note 'Buy milk' appears in the list"] },
      answer: { found, answer: found ? "The list contains: Buy milk" : "the list is empty" },
    }
  );
  const judge = new ScriptedLlm([], {
    submit_verdict: {
      decision: verdict,
      confidence: verdict === "pass" ? 0.95 : 0.4,
      summary: verdict === "pass" ? "The note was added and is visible." : "The note never appeared.",
      checkpoints: [{ id: 1, status: verdict === "pass" ? "met" : "unmet", evidence: "list shows Buy milk" }],
      issues: [],
    },
  });
  return { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient };
}

const spec = () => ({
  title: "Add a note",
  task: "Type 'Buy milk' and click Add.",
  intent: "The note 'Buy milk' appears in the list.",
  app: { url: base },
});

describe("runSpec full pipeline (scripted LLM, real browser)", () => {
  it("drives plan -> loop -> judge -> report and returns a pass verdict", async () => {
    const report = await runSpec(spec(), {
      config: { apiKey: "test-key", runsDir },
      clients: makeClients("pass"),
    });

    expect(report.verdict.decision).toBe("pass");
    expect(report.plan.checkpoints).toHaveLength(1);
    expect(report.steps.length).toBeGreaterThanOrEqual(3);
    // The real browser actually executed the actions:
    expect(report.steps.some((s) => s.call.name === "type")).toBe(true);
    expect(report.steps.some((s) => s.call.name === "click")).toBe(true);
    // Verdict checkpoint resolved by the judge:
    expect(report.verdict.checkpoints[0].status).toBe("met");
    // Per-step timing is captured (real wall-clock execution).
    expect(report.steps.every((s) => typeof s.durationMs === "number")).toBe(true);
  }, 30_000);

  it("writes report.json / report.md / report.html / trace.html to the run dir", async () => {
    const report = await runSpec(spec(), {
      config: { apiKey: "test-key", runsDir },
      clients: makeClients("pass"),
    });
    for (const f of ["report.json", "report.md", "report.html", "trace.html"]) {
      expect(fs.existsSync(path.join(report.runDir, f)), f).toBe(true);
    }
  }, 30_000);

  it("propagates a fail verdict from the judge", async () => {
    const report = await runSpec(spec(), {
      config: { apiKey: "test-key", runsDir },
      clients: makeClients("fail", false),
    });
    expect(report.verdict.decision).toBe("fail");
  }, 30_000);

  it("short-circuits to inconclusive when the app is unreachable — no LLM calls", async () => {
    // Clients that throw if touched: proves the short-circuit happens pre-LLM.
    const exploding = {
      async turn() {
        throw new Error("LLM should not be called for an unreachable app");
      },
      async structured() {
        throw new Error("LLM should not be called for an unreachable app");
      },
    } as unknown as LlmClient;

    const deadSpec = {
      title: "Dead app",
      task: "do something",
      intent: "it works",
      // Port 1 is not listening -> connection refused.
      app: { url: "http://127.0.0.1:1/" },
    };
    const report = await runSpec(deadSpec, {
      config: { apiKey: "test-key", runsDir, maxDurationMs: 8000 },
      clients: { llm: exploding, judge: exploding },
    });
    expect(report.verdict.decision).toBe("inconclusive");
    expect(report.verdict.summary).toMatch(/could not load/i);
    expect(report.steps).toHaveLength(0);
    expect(report.usage?.total.calls ?? 0).toBe(0);
  }, 30_000);

  it("honors one action per turn — extra tool calls in a turn are skipped", async () => {
    // First turn emits TWO type actions at once; only the first must execute.
    const actor = new ScriptedLlm(
      [
        [
          { name: "type", input: { index: 0, text: "First" } },
          { name: "type", input: { index: 0, text: "Second-should-be-skipped" } },
        ],
        { name: "click", input: { index: 1 } },
        { name: "done", input: { outcome: "success", notes: "done" } },
      ],
      {
        submit_plan: { goal: "g", checkpoints: ["note appears"] },
        answer: { found: true, answer: "First" },
      }
    );
    const judge = new ScriptedLlm([], {
      submit_verdict: { decision: "pass", confidence: 1, summary: "ok", checkpoints: [{ id: 1, status: "met", evidence: "x" }], issues: [] },
    });
    const report = await runSpec(spec(), {
      config: { apiKey: "test-key", runsDir },
      clients: { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient },
    });
    // The skipped 2nd action must NOT produce a step.
    const typeSteps = report.steps.filter((s) => s.call.name === "type");
    expect(typeSteps).toHaveLength(1);
    expect(typeSteps[0].call.input.text).toBe("First");
  }, 30_000);
});

/**
 * Kitchen-sink composition test: a11y + visual + perf-budget + network mocks +
 * file upload + dialog handling, all flowing through ONE runSpec. Proves the QA
 * dimensions (built and probed in isolation) don't break each other in the real
 * pipeline.
 */
describe("runSpec QA dimensions compose (scripted LLM, real browser)", () => {
  let kServer: http.Server;
  let kBase = "";
  let kRuns = "";
  let kBaselines = "";
  let uploadFile = "";

  // Page: an unlabeled img (a11y), a file input, a delete button that confirms,
  // and content fetched from an API (mockable).
  const KPAGE = `<!doctype html><html lang="en"><head><title>Kitchen</title></head><body>
    <main>
      <h1>Records</h1>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">
      <input id="f" type="file">
      <button id="del" onclick="confirm('Delete all records?')">Delete</button>
      <div id="out">loading</div>
    </main>
    <script>fetch('/api/records').then(r=>r.json()).then(j=>{document.getElementById('out').textContent='RECORDS='+j.length;});</script>
  </body></html>`;

  beforeAll(async () => {
    kServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(KPAGE);
    });
    await new Promise<void>((r) => kServer.listen(0, r));
    kBase = `http://127.0.0.1:${(kServer.address() as { port: number }).port}/`;
    kRuns = fs.mkdtempSync(path.join(os.tmpdir(), "sn-kitchen-runs-"));
    kBaselines = fs.mkdtempSync(path.join(os.tmpdir(), "sn-kitchen-bl-"));
    uploadFile = path.join(kRuns, "avatar.png");
    fs.writeFileSync(uploadFile, "PNGBYTES");
  });

  afterAll(async () => {
    await new Promise<void>((r) => kServer.close(() => r()));
    fs.rmSync(kRuns, { recursive: true, force: true });
    fs.rmSync(kBaselines, { recursive: true, force: true });
  });

  it("runs a11y, visual, perf budget, mocks, upload and a dialog in one spec", async () => {
    const actor = new ScriptedLlm(
      [
        { name: "click", input: { index: 0 } }, // file input -> chooser -> upload fed
        { name: "click", input: { index: 1 } }, // delete -> confirm() auto-accepted
        { name: "done", input: { outcome: "success", notes: "did the flow" } },
      ],
      {
        submit_plan: { goal: "exercise the page", checkpoints: ["records load"] },
        answer: { found: true, answer: "RECORDS=3" },
      }
    );
    const judge = new ScriptedLlm([], {
      submit_verdict: { decision: "pass", confidence: 1, summary: "ok", checkpoints: [{ id: 1, status: "met", evidence: "x" }], issues: [] },
    });

    const report = await runSpec(
      {
        title: "Kitchen sink",
        task: "Upload a file and delete records.",
        intent: "The flow completes.",
        app: { url: kBase },
        a11y: true,
        visual: true,
        perfBudget: { loadMs: 1 }, // 1ms is unmeetable -> a deterministic breach
        mocks: [{ url: "**/api/records", json: [1, 2, 3] }],
        uploads: [uploadFile],
      },
      {
        config: { apiKey: "test-key", runsDir: kRuns, baselinesDir: kBaselines },
        clients: { llm: actor as unknown as LlmClient, judge: judge as unknown as LlmClient },
      }
    );

    // a11y: the unlabeled image is flagged, with its selector.
    expect(report.a11y).toBeDefined();
    expect(report.a11y!.violations.some((v) => v.id === "image-alt")).toBe(true);

    // visual: first run with no baseline captures one.
    expect(report.visual?.status).toBe("new-baseline");
    expect(fs.existsSync(path.join(kBaselines, `${report.spec.id ?? "kitchen-sink"}.png`)) || fs.readdirSync(kBaselines).length > 0).toBe(true);

    // perf: metrics captured + the 1ms budget breached.
    expect(report.perfMetrics).toBeDefined();
    expect(report.perfBudgetViolations?.some((v) => v.metric === "loadMs")).toBe(true);

    // mocks: the API stub was actually requested.
    const mock = report.mockActivity?.find((m) => m.description.includes("/api/records"));
    expect(mock?.hits).toBeGreaterThanOrEqual(1);

    // upload: the file was fed to the chooser.
    expect(report.uploads).toContain("avatar.png");

    // dialog: the confirm() was auto-accepted.
    expect(report.dialogs?.some((d) => d.type === "confirm" && d.message.includes("Delete all records"))).toBe(true);

    // and the functional verdict still came through.
    expect(report.verdict.decision).toBe("pass");
  }, 30_000);
});
