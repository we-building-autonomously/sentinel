import { describe, it, expect } from "vitest";
import { judge, shouldVisionJudge } from "./judge.js";
import { CallbackLlm } from "../testing/callback-llm.js";
import type { LlmClient } from "../llm/anthropic.js";
import type { Plan, TestSpec } from "../types.js";

const spec: TestSpec = {
  title: "t",
  task: "do the thing",
  intent: "the thing is done",
  app: { url: "http://x" },
};
const plan: Plan = {
  goal: "do the thing",
  checkpoints: [
    { id: 1, description: "first" },
    { id: 2, description: "second" },
  ],
};

/** A judge LLM that returns whatever raw verdict we hand it. */
function fakeJudge(raw: unknown): LlmClient {
  return new CallbackLlm(() => ({ tool: "noop", input: {} }), {
    submit_verdict: () => raw,
  }) as unknown as LlmClient;
}

describe("judge() applies verdict reconciliation", () => {
  it("downgrades a self-contradicting pass (checkpoint unmet) to fail", async () => {
    const v = await judge({
      llm: fakeJudge({
        decision: "pass",
        confidence: 0.97,
        summary: "looks good",
        checkpoints: [
          { id: 1, status: "met", evidence: "saw it" },
          { id: 2, status: "unmet", evidence: "never happened" },
        ],
        issues: [],
      }),
      spec,
      plan,
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
    });

    expect(v.decision).toBe("fail");
    expect(v.confidence).toBeLessThanOrEqual(0.5);
    expect(v.issues.some((i) => /reconciled pass→fail/.test(i))).toBe(true);
    // The merged checkpoint resolution is preserved on the verdict.
    expect(v.checkpoints.find((c) => c.id === 2)?.status).toBe("unmet");
  });

  it("surfaces download evidence (incl. an empty-file warning) in the judge prompt", async () => {
    let seen = "";
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        seen = String(o.prompt);
        return { decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "export", checkpoints: [] },
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
      downloads: [
        { filename: "report.csv", bytes: 42 },
        { filename: "empty.csv", bytes: 0 },
      ],
    });
    expect(seen).toMatch(/FILE DOWNLOADS/);
    expect(seen).toMatch(/report\.csv.*42 bytes/);
    expect(seen).toMatch(/empty\.csv.*empty file, likely a defect/);
  });

  it("surfaces a final-page error state in the judge prompt", async () => {
    let seen = "";
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        seen = String(o.prompt);
        return { decision: "fail", confidence: 0.9, summary: "crash", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "open dashboard", checkpoints: [] },
      steps: [],
      done: { outcome: "failure", notes: "n" },
      exhausted: false,
      finalPageText: "",
      errorState: { kind: "http-5xx", evidence: "500 Internal Server Error" },
    });
    expect(seen).toMatch(/FINAL PAGE ERROR STATE/);
    expect(seen).toMatch(/http-5xx/);
    expect(seen).toMatch(/500 Internal Server Error/);
  });

  it("gives the judge navigation evidence: final URL and per-step nav transitions", async () => {
    let seen = "";
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        seen = String(o.prompt);
        return { decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    const steps = [
      { index: 0, call: { name: "type", input: {} }, result: { ok: true, summary: "typed" }, url: "http://x/login", timestamp: "t" },
      { index: 1, call: { name: "click", input: {} }, result: { ok: true, summary: "clicked" }, url: "http://x/dashboard", timestamp: "t" },
    ];
    await judge({
      llm: capturing,
      spec: { ...spec, app: { url: "http://x/login" } },
      plan: { goal: "log in", checkpoints: [] },
      steps,
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
      finalUrl: "http://x/dashboard",
    });
    expect(seen).toMatch(/NAVIGATION: started at http:\/\/x\/login · ended at http:\/\/x\/dashboard/);
    // The step that changed the URL is annotated in the trace.
    expect(seen).toMatch(/navigated to http:\/\/x\/dashboard/);
  });

  it("includes the final page title in the navigation evidence", async () => {
    let seen = "";
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        seen = String(o.prompt);
        return { decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "g", checkpoints: [] },
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
      finalUrl: "http://x/orders/1234",
      finalTitle: "Order #1234 — Acme",
    });
    expect(seen).toMatch(/final page title "Order #1234 — Acme"/);
  });

  it("attaches the screenshot to the judge as a multimodal image block", async () => {
    let prompt: unknown;
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        prompt = o.prompt;
        return { decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "g", checkpoints: [] },
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
      screenshot: { data: "QUJD", mediaType: "image/png" },
    });
    expect(Array.isArray(prompt)).toBe(true);
    const blocks = prompt as Array<{ type: string; source?: { data: string } }>;
    expect(blocks.some((b) => b.type === "text")).toBe(true);
    const img = blocks.find((b) => b.type === "image");
    expect(img?.source?.data).toBe("QUJD");
  });

  it("sends a plain string prompt when no screenshot is provided", async () => {
    let prompt: unknown;
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        prompt = o.prompt;
        return { decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "g", checkpoints: [] },
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
    });
    expect(typeof prompt).toBe("string");
  });

  it("surfaces text assertions in the judge prompt", async () => {
    let seen = "";
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        seen = String(o.prompt);
        return { decision: "fail", confidence: 0.9, summary: "x", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "g", checkpoints: [] },
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
      textChecks: ['UNMET: forbidden text "undefined" — PRESENT (should not be)'],
    });
    expect(seen).toMatch(/TEXT ASSERTIONS/);
    expect(seen).toMatch(/forbidden text "undefined"/);
  });

  it("surfaces a horizontal-overflow layout note in the judge prompt", async () => {
    let seen = "";
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        seen = String(o.prompt);
        return { decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "g", checkpoints: [] },
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
      layout: "the page is 800px wide but the viewport is 390px — content overflows horizontally",
    });
    expect(seen).toMatch(/RESPONSIVE LAYOUT/);
    expect(seen).toMatch(/800px.*390px/);
  });

  it("surfaces captured toast/status announcements in the judge prompt", async () => {
    let seen = "";
    const capturing = new CallbackLlm(() => ({ tool: "noop", input: {} }), {
      submit_verdict: (o: { prompt: unknown }) => {
        seen = String(o.prompt);
        return { decision: "pass", confidence: 0.9, summary: "ok", checkpoints: [], issues: [] };
      },
    }) as unknown as LlmClient;
    await judge({
      llm: capturing,
      spec,
      plan: { goal: "g", checkpoints: [] },
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
      liveAnnouncements: ["Saved successfully"],
    });
    expect(seen).toMatch(/TRANSIENT TOAST\/STATUS MESSAGES/);
    expect(seen).toMatch(/Saved successfully/);
  });

  it("passes through a coherent pass unchanged", async () => {
    const v = await judge({
      llm: fakeJudge({
        decision: "pass",
        confidence: 0.9,
        summary: "all good",
        checkpoints: [
          { id: 1, status: "met", evidence: "a" },
          { id: 2, status: "met", evidence: "b" },
        ],
        issues: [],
      }),
      spec,
      plan,
      steps: [],
      done: { outcome: "success", notes: "n" },
      exhausted: false,
      finalPageText: "",
    });
    expect(v.decision).toBe("pass");
    expect(v.confidence).toBe(0.9);
  });
});
