import { describe, it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, streamRun, sseFrame, resolveRunsFile, listRuns, type RunRequest } from "./server.js";
import type { RunReport, RunOptions } from "./runner.js";

function fakeReport(): RunReport {
  return {
    spec: { title: "t", task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: { decision: "pass", confidence: 0.9, summary: "looks good", checkpoints: [{ id: 1, description: "cp", status: "met" }], issues: [] },
    triage: { category: "passed", reason: "ok", actionable: false },
    usage: { byModel: {}, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }, costUsd: 0.02 },
    startedAt: "", finishedAt: "", durationMs: 1234, runDir: "/abs/runs/t-123",
  } as RunReport;
}

// A runner that drives the onStart/onPhase/onStep callbacks like the real one would.
async function fakeRunner(_spec: unknown, options: RunOptions): Promise<RunReport> {
  options.onStart?.({ runDir: "/abs/runs/t-123" });
  options.onPhase?.("navigating");
  options.onPhase?.("planning");
  options.onStep?.({ index: 0, call: { name: "click", input: { index: 1 } }, result: { ok: true, summary: "Clicked", screenshot: "step-0.png" }, thought: "go" } as never);
  options.onPhase?.("judging");
  return fakeReport();
}

function frames(out: string[]): Array<{ event: string; data: unknown }> {
  return out.join("").split("\n\n").filter(Boolean).map((f) => ({
    event: (f.match(/^event: (.+)$/m) || [])[1],
    data: JSON.parse((f.match(/^data: (.+)$/m) || [])[1]),
  }));
}

describe("sseFrame", () => {
  it("formats an SSE event+data frame", () => {
    expect(sseFrame("phase", { phase: "planning" })).toBe('event: phase\ndata: {"phase":"planning"}\n\n');
  });
});

describe("streamRun", () => {
  it("streams started → phases → step → verdict → done for a valid run", async () => {
    const out: string[] = [];
    await streamRun({ url: "https://demo.test", task: "do x", intent: "y" }, (f) => out.push(f), { run: fakeRunner });
    const evs = frames(out);
    expect(evs.map((e) => e.event)).toEqual(["started", "phase", "phase", "step", "phase", "verdict", "done"]);
    const verdict = evs.find((e) => e.event === "verdict")!.data as Record<string, unknown>;
    expect(verdict.decision).toBe("pass");
    expect(verdict.reportUrl).toBe("/runs/t-123/report.html"); // basename of runDir
    expect((evs.at(-1)!.data as { ok: boolean }).ok).toBe(true);
    // The step carries a live screenshot URL under the run folder.
    const step = evs.find((e) => e.event === "step")!.data as Record<string, unknown>;
    expect(step.screenshot).toBe("/runs/t-123/step-0.png");
  });

  it("emits an error frame (no crash) when the spec is invalid", async () => {
    const out: string[] = [];
    await streamRun({ url: "", task: "" } as RunRequest, (f) => out.push(f), { run: fakeRunner });
    const evs = frames(out);
    expect(evs[0].event).toBe("error");
    expect(evs.at(-1)).toMatchObject({ event: "done", data: { ok: false } });
  });

  it("turns a runner crash into an error frame, not a throw", async () => {
    const out: string[] = [];
    await streamRun({ url: "https://x.test", task: "t", intent: "i" }, (f) => out.push(f), {
      run: async () => { throw new Error("boom\nstack"); },
    });
    const evs = frames(out);
    expect(evs.find((e) => e.event === "error")!.data).toMatchObject({ message: "boom" }); // first line only
  });
});

describe("listRuns", () => {
  function tmpRunsWith(reports: Array<{ folder: string; title: string; decision: string; startedAt: string }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-runs-"));
    for (const r of reports) {
      const rd = path.join(dir, r.folder);
      fs.mkdirSync(rd, { recursive: true });
      const report = {
        spec: { title: r.title, task: "x", intent: "y", app: { url: "https://e.com" } },
        plan: { goal: "g", checkpoints: [] },
        steps: [],
        verdict: { decision: r.decision, confidence: 1, summary: "", checkpoints: [], issues: [] },
        triage: { category: r.decision === "pass" ? "passed" : "product-defect", reason: "", actionable: false },
        usage: { byModel: {}, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }, costUsd: 0.01 },
        startedAt: r.startedAt, finishedAt: r.startedAt, durationMs: 1000, runDir: rd,
      };
      fs.writeFileSync(path.join(rd, "report.json"), JSON.stringify(report));
    }
    return dir;
  }

  it("lists past runs newest-first with a report URL derived from the run folder", () => {
    const dir = tmpRunsWith([
      { folder: "login-2026-06-01", title: "Login", decision: "pass", startedAt: "2026-06-01T10:00:00Z" },
      { folder: "checkout-2026-06-03", title: "Checkout", decision: "fail", startedAt: "2026-06-03T10:00:00Z" },
    ]);
    const runs = listRuns(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(runs.map((r) => r.title)).toEqual(["Checkout", "Login"]); // newest first
    expect(runs[0]).toMatchObject({ decision: "fail", reportUrl: "/runs/checkout-2026-06-03/report.html" });
  });

  it("is empty for a runs dir with no reports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-empty-"));
    expect(listRuns(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveRunsFile path-traversal guard", () => {
  it("resolves a normal runs path", () => {
    expect(resolveRunsFile("/runs/abc/report.html", "/base")).toBe("/base/abc/report.html");
  });
  it("rejects traversal outside runsDir", () => {
    expect(resolveRunsFile("/runs/../../etc/passwd", "/base")).toBeNull();
  });
});

describe("createServer (HTTP)", () => {
  function listen(): Promise<{ url: string; close: () => void }> {
    const server = createServer({ run: fakeRunner, runsDir: "/tmp/sn-serve-test" });
    return new Promise((resolve) => server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }));
  }

  it("serves the dashboard HTML at /", async () => {
    const s = await listen();
    const res = await fetch(s.url + "/");
    const body = await res.text();
    s.close();
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(body).toContain("Sentinel");
    expect(body).toContain("/api/run");
  });

  it("streams an SSE run over POST /api/run", async () => {
    const s = await listen();
    const res = await fetch(s.url + "/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://demo.test", task: "do x", intent: "y" }),
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    s.close();
    expect(text).toContain("event: started");
    expect(text).toContain("event: verdict");
    expect(text).toContain('"decision":"pass"');
  });

  it("serves the run history as JSON at /api/runs", async () => {
    const s = await listen();
    const res = await fetch(s.url + "/api/runs");
    const body = await res.json();
    s.close();
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(Array.isArray(body)).toBe(true); // empty (the test runsDir has no reports) but valid
  });

  it("404s an unknown route", async () => {
    const s = await listen();
    const res = await fetch(s.url + "/nope");
    s.close();
    expect(res.status).toBe(404);
  });
});
