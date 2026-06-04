import { describe, it, expect } from "vitest";
import { DiagnosticsCollector } from "./diagnostics.js";

describe("DiagnosticsCollector", () => {
  it("captures page errors and console errors, ignores non-errors", () => {
    const d = new DiagnosticsCollector();
    d.pageError("TypeError: x is not a function\n  at foo.js:1");
    d.consoleMessage("error", "Failed to fetch user");
    d.consoleMessage("warning", "deprecation notice");
    d.consoleMessage("log", "hello");
    const list = d.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ kind: "pageerror", text: "TypeError: x is not a function" });
    expect(list[1].text).toBe("Failed to fetch user");
  });

  it("records 4xx/5xx responses with the right level, ignores 2xx/3xx", () => {
    const d = new DiagnosticsCollector();
    d.response(200, "https://api.example.com/ok");
    d.response(404, "https://api.example.com/missing", "GET");
    d.response(500, "https://api.example.com/boom", "POST");
    const list = d.list();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.status === 404)!.level).toBe("warning");
    expect(list.find((x) => x.status === 500)!.level).toBe("error");
  });

  it("dedups repeats and counts them", () => {
    const d = new DiagnosticsCollector();
    for (let i = 0; i < 5; i++) d.pageError("same error");
    expect(d.list()).toHaveLength(1);
    expect(d.list()[0].count).toBe(5);
  });

  it("filters known noise (favicon, ResizeObserver, devtools)", () => {
    const d = new DiagnosticsCollector();
    d.response(404, "https://app.example.com/favicon.ico");
    d.pageError("ResizeObserver loop completed with undelivered notifications");
    d.consoleMessage("error", "Download the React DevTools for a better experience");
    expect(d.list()).toHaveLength(0);
  });

  it("respects the cap but keeps counting dupes already tracked", () => {
    const d = new DiagnosticsCollector(2);
    d.pageError("a");
    d.pageError("b");
    d.pageError("c"); // dropped (cap reached, new key)
    d.pageError("a"); // still counted (existing key)
    const list = d.list();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.text === "a")!.count).toBe(2);
  });

  it("errorCount sums error-level occurrences only", () => {
    const d = new DiagnosticsCollector();
    d.response(404, "https://api.example.com/x"); // warning
    d.pageError("boom");
    d.pageError("boom");
    expect(d.errorCount).toBe(2);
  });

  it("forJudge renders a block, or empty string when clean", () => {
    const clean = new DiagnosticsCollector();
    expect(clean.forJudge()).toBe("");
    const d = new DiagnosticsCollector();
    d.pageError("boom");
    d.pageError("boom");
    expect(d.forJudge()).toContain("[error/pageerror] boom (x2)");
  });
});
