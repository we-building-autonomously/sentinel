import { describe, it, expect, vi, afterEach } from "vitest";
import { reportRun } from "./cloud.js";
import type { RunReport } from "./types.js";

function fakeReport(): RunReport {
  return {
    spec: { title: "t", task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: { decision: "fail", confidence: 0.9, summary: "broke", checkpoints: [], issues: [] },
    triage: { category: "product-defect", reason: "r", actionable: true },
    startedAt: "",
    finishedAt: "",
    durationMs: 10,
    runDir: "/runs/t",
  } as RunReport;
}

const ENV = { url: process.env.SENTINEL_CLOUD_URL, key: process.env.SENTINEL_API_KEY };
afterEach(() => {
  process.env.SENTINEL_CLOUD_URL = ENV.url;
  process.env.SENTINEL_API_KEY = ENV.key;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reportRun", () => {
  it("is a no-op (no fetch) when not configured", async () => {
    delete process.env.SENTINEL_CLOUD_URL;
    delete process.env.SENTINEL_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportRun(fakeReport());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the QaResult to /api/runs with the bearer key when configured", async () => {
    process.env.SENTINEL_CLOUD_URL = "https://app.sentinel.dev/"; // trailing slash trimmed
    process.env.SENTINEL_API_KEY = "sk_sntl_abc";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ creditBalance: 9 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await reportRun(fakeReport());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.sentinel.dev/api/runs");
    expect((opts.headers as Record<string, string>).authorization).toBe("Bearer sk_sntl_abc");
    const body = JSON.parse(opts.body as string);
    expect(body.decision).toBe("fail");
    expect(body.triage.category).toBe("product-defect");
  });

  it("swallows network errors (never throws)", async () => {
    process.env.SENTINEL_CLOUD_URL = "https://app.sentinel.dev";
    process.env.SENTINEL_API_KEY = "sk_sntl_abc";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(reportRun(fakeReport())).resolves.toBeUndefined();
  });
});
