import { describe, it, expect } from "vitest";
import { runHook, runHooks, type HttpHook } from "./hooks.js";

function fakeFetch(map: Record<string, number | "throw">) {
  const calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];
  const fn = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const v = map[url];
    if (v === "throw") throw new Error("ECONNREFUSED");
    return { status: v ?? 200 };
  };
  return { fn, calls };
}

describe("runHook", () => {
  it("defaults to GET and treats any 2xx as ok", async () => {
    const { fn, calls } = fakeFetch({ "https://api/x": 204 });
    const r = await runHook({ url: "https://api/x" }, { fetchImpl: fn });
    expect(r).toEqual({ method: "GET", url: "https://api/x", status: 204, ok: true, error: undefined });
    expect(calls[0].method).toBe("GET");
  });

  it("passes method, headers and body through", async () => {
    const { fn, calls } = fakeFetch({ "https://api/u": 201 });
    const hook: HttpHook = { method: "POST", url: "https://api/u", headers: { "x-api-key": "k" }, body: '{"a":1}' };
    const r = await runHook(hook, { fetchImpl: fn });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", headers: { "x-api-key": "k" }, body: '{"a":1}' });
  });

  it("fails a non-2xx with a descriptive error", async () => {
    const { fn } = fakeFetch({ "https://api/x": 500 });
    const r = await runHook({ url: "https://api/x" }, { fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, status: 500, error: "non-2xx status 500" });
  });

  it("honours expectStatus (e.g. a 404 is the success condition)", async () => {
    const { fn } = fakeFetch({ "https://api/gone": 404 });
    expect((await runHook({ url: "https://api/gone", expectStatus: 404 }, { fetchImpl: fn })).ok).toBe(true);
    const { fn: fn2 } = fakeFetch({ "https://api/x": 200 });
    const r = await runHook({ url: "https://api/x", expectStatus: 204 }, { fetchImpl: fn2 });
    expect(r).toMatchObject({ ok: false, error: "expected status 204, got 200" });
  });

  it("captures a network error without throwing", async () => {
    const { fn } = fakeFetch({ "https://api/down": "throw" });
    const r = await runHook({ url: "https://api/down" }, { fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, error: "ECONNREFUSED" });
    expect(r.status).toBeUndefined();
  });
});

describe("runHooks", () => {
  it("runs all hooks in order and returns every result", async () => {
    const { fn, calls } = fakeFetch({ "https://api/a": 200, "https://api/b": 200 });
    const out = await runHooks([{ url: "https://api/a" }, { url: "https://api/b" }], { fetchImpl: fn });
    expect(out.map((r) => r.ok)).toEqual([true, true]);
    expect(calls.map((c) => c.url)).toEqual(["https://api/a", "https://api/b"]);
  });

  it("stops early on the first failure when stopOnError is set", async () => {
    const { fn, calls } = fakeFetch({ "https://api/a": 500, "https://api/b": 200 });
    const out = await runHooks([{ url: "https://api/a" }, { url: "https://api/b" }], { fetchImpl: fn, stopOnError: true });
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(false);
    expect(calls).toHaveLength(1); // never reached b
  });

  it("continues past a failure by default (teardown is best-effort)", async () => {
    const { fn } = fakeFetch({ "https://api/a": 500, "https://api/b": 200 });
    const out = await runHooks([{ url: "https://api/a" }, { url: "https://api/b" }], { fetchImpl: fn });
    expect(out.map((r) => r.ok)).toEqual([false, true]);
  });

  it("is empty for undefined/no hooks", async () => {
    expect(await runHooks(undefined)).toEqual([]);
    expect(await runHooks([])).toEqual([]);
  });
});
