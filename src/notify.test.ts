import { describe, it, expect } from "vitest";
import {
  buildSuitePayload,
  buildSlackMessage,
  buildRegressionMessage,
  isSlackUrl,
  notifySuite,
  notifyRegression,
  type FetchLike,
} from "./notify.js";
import type { RunReport, Decision } from "./types.js";

function rep(title: string, decision: Decision, opts: { flaky?: boolean; cost?: number } = {}): RunReport {
  return {
    spec: { title, task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: { decision, confidence: 0.9, summary: `outcome for ${title}`, checkpoints: [], issues: [] },
    usage: { byModel: {}, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }, costUsd: opts.cost ?? 0.01 },
    flaky: opts.flaky,
    startedAt: "", finishedAt: "", durationMs: 1000, runDir: "",
  };
}

const mixed = [rep("Login", "pass"), rep("Checkout", "fail"), rep("Search", "pass", { flaky: true })];

describe("buildSuitePayload", () => {
  it("summarizes counts, cost, and per-spec results", () => {
    const p = buildSuitePayload("Smoke", mixed, "2026-01-01T00:00:00Z");
    expect(p.ok).toBe(false);
    expect(p.summary).toMatchObject({ total: 3, pass: 2, fail: 1, flaky: 1 });
    expect(p.costUsd).toBeCloseTo(0.03, 6);
    expect(p.results).toHaveLength(3);
    expect(p.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  it("marks ok=true only when nothing failed or was inconclusive", () => {
    expect(buildSuitePayload("s", [rep("a", "pass"), rep("b", "pass")]).ok).toBe(true);
    expect(buildSuitePayload("s", [rep("a", "inconclusive")]).ok).toBe(false);
  });
});

describe("buildSlackMessage", () => {
  it("uses a red headline and lists only non-passing/flaky specs", () => {
    const m = buildSlackMessage("Smoke", mixed);
    expect(m.text).toContain(":red_circle:");
    const json = JSON.stringify(m.blocks);
    expect(json).toContain("Checkout");
    expect(json).toContain("Search"); // flaky surfaces even though it passed
    expect(json).not.toContain("Login"); // clean pass is omitted from the detail list
  });

  it("adds a triage rollup and tags each listed spec with its category", () => {
    const json = JSON.stringify(buildSlackMessage("Smoke", mixed).blocks);
    expect(json).toContain("Triage:");
    expect(json).toContain("product defect"); // Checkout fail -> product-defect
    expect(json).toContain("product-defect"); // per-spec category tag on the Checkout line
    expect(json).toContain("flaky-pass"); // the flaky pass is tagged too
  });

  it("adds a QA rollup line when a dimension has issues", () => {
    const sec = rep("Sec", "pass");
    (sec as { security?: unknown }).security = {
      findings: [{ id: "content-security-policy", severity: "high", message: "x" }],
      counts: { high: 1, medium: 0, low: 0 },
    };
    const json = JSON.stringify(buildSlackMessage("Smoke", [sec]).blocks);
    expect(json).toContain("QA:");
    expect(json).toContain("1 security");
  });

  it("stays terse and green when everything passes", () => {
    const m = buildSlackMessage("Smoke", [rep("a", "pass"), rep("b", "pass")]);
    expect(m.text).toContain(":large_green_circle:");
    // header + context only, no detail section
    expect(m.blocks).toHaveLength(2);
  });
});

describe("isSlackUrl", () => {
  it("detects slack incoming webhooks", () => {
    expect(isSlackUrl("https://hooks.slack.com/services/T/B/X")).toBe(true);
    expect(isSlackUrl("https://example.com/webhook")).toBe(false);
  });
});

describe("notifySuite", () => {
  it("posts a Slack body to slack URLs", async () => {
    let captured: any;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200 };
    };
    const res = await notifySuite("https://hooks.slack.com/services/x", "Smoke", mixed, { fetchImpl });
    expect(res.sent).toBe(true);
    expect(captured.body.blocks).toBeDefined();
  });

  it("posts the structured payload to a generic webhook", async () => {
    let body: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200 };
    };
    await notifySuite("https://example.com/hook", "Smoke", mixed, { fetchImpl });
    expect(body.suite).toBe("Smoke");
    expect(body.results).toHaveLength(3);
  });

  it("reports a failed send without throwing", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500 });
    const res = await notifySuite("https://example.com/hook", "s", mixed, { fetchImpl });
    expect(res.sent).toBe(false);
    expect(res.error).toContain("500");
  });

  it("captures a network error as a failed send", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await notifySuite("https://example.com/hook", "s", mixed, { fetchImpl });
    expect(res.sent).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("regression alerts", () => {
  const regressed = [{ title: "Checkout" }, { title: "Login [mobile]" }];

  it("builds a Slack body with the regressed titles", () => {
    const body = JSON.parse(buildRegressionMessage(regressed, true));
    expect(body.text).toContain("2 spec(s) regressed");
    expect(JSON.stringify(body.blocks)).toContain("Checkout");
    expect(JSON.stringify(body.blocks)).toContain("Login [mobile]");
  });

  it("builds a structured payload for a generic webhook", () => {
    const body = JSON.parse(buildRegressionMessage(regressed, false));
    expect(body).toMatchObject({ event: "regression", count: 2 });
    expect(body.specs).toEqual(["Checkout", "Login [mobile]"]);
  });

  it("notifyRegression posts when there are regressions", async () => {
    let captured: any;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200 };
    };
    const res = await notifyRegression("https://hooks.slack.com/x", regressed, { fetchImpl });
    expect(res.sent).toBe(true);
    expect(captured.body.blocks).toBeDefined();
  });

  it("notifyRegression is a no-op when nothing regressed", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => ((called = true), { ok: true, status: 200 });
    const res = await notifyRegression("https://example.com/hook", [], { fetchImpl });
    expect(res.sent).toBe(false);
    expect(called).toBe(false);
  });
});
