import { describe, it, expect } from "vitest";
import { toTraceViewer } from "./trace-viewer.js";
import type { RunReport } from "../types.js";

function fixture(over: Partial<RunReport> = {}): RunReport {
  return {
    spec: { title: "Checkout flow", task: "buy", intent: "order placed", app: { url: "https://shop.example.com" } },
    plan: { goal: "buy", checkpoints: [{ id: 1, description: "Order confirmation shown" }] },
    steps: [
      {
        index: 0,
        thought: "I will click the Buy button",
        call: { name: "click", input: { index: 3 } },
        result: { ok: true, summary: "Clicked [3] Buy", screenshot: "000-click.png" },
        url: "https://shop.example.com/cart",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        index: 1,
        call: { name: "type", input: { index: 5, text: "4242" } },
        result: { ok: false, summary: "Element [5] no longer exists" },
        url: "https://shop.example.com/pay",
        timestamp: "2026-01-01T00:00:01Z",
      },
    ],
    verdict: {
      decision: "fail",
      confidence: 0.8,
      summary: "Payment field vanished",
      checkpoints: [{ id: 1, description: "Order confirmation shown", status: "unmet", evidence: "never reached" }],
      issues: [],
    },
    diagnostics: [{ kind: "pageerror", level: "error", text: "Uncaught X", count: 1 }],
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:02Z",
    durationMs: 2000,
    runDir: "/runs/x",
    ...over,
  };
}

describe("toTraceViewer", () => {
  it("produces a standalone HTML doc with the verdict and title", () => {
    const html = toTraceViewer(fixture());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Checkout flow");
    expect(html).toContain("fail");
  });

  it("embeds every step (tool, summary, screenshot) in the data blob", () => {
    const html = toTraceViewer(fixture());
    expect(html).toContain("000-click.png");
    expect(html).toContain("Clicked [3] Buy");
    expect(html).toContain("Element [5] no longer exists");
  });

  it("includes checkpoints and diagnostics for the overview", () => {
    const html = toTraceViewer(fixture());
    expect(html).toContain("Order confirmation shown");
    expect(html).toContain("Uncaught X");
  });

  it("neutralizes </script> break-out in embedded data", () => {
    const html = toTraceViewer(fixture({
      spec: { title: "</script><script>alert(1)</script>", task: "t", intent: "i", app: { url: "https://e.com" } },
    } as Partial<RunReport>));
    // The raw closing tag must not appear inside the JSON blob.
    expect(html).toContain("\\u003c/script");
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
  });

  it("marks a flaky run", () => {
    const html = toTraceViewer(fixture({ flaky: true }));
    expect(html).toContain('class="flaky"');
  });
});
