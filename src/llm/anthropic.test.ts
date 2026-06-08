import { describe, it, expect } from "vitest";
import { LlmClient, isRetriableStatus, retryAfterMs, type MessagesApi } from "./anthropic.js";
import { UsageMeter } from "../usage.js";

/** Build a fake Message with a forced tool_use block and a stop reason. */
function toolMessage(input: unknown, stop: "tool_use" | "max_tokens", out = 50) {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "x",
    stop_reason: stop,
    stop_sequence: null,
    content: [{ type: "tool_use", id: "t", name: "submit", input }],
    usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never;
}

function fakeClient(responses: ReturnType<typeof toolMessage>[]) {
  let i = 0;
  const state = { calls: 0 };
  const api: MessagesApi = {
    messages: {
      create: async () => {
        state.calls++;
        return responses[Math.min(i++, responses.length - 1)];
      },
    },
  };
  return { api, state };
}

const SCHEMA = { type: "object" as const, properties: { a: { type: "string" } }, required: ["a"] };

/** A fake that rejects `temperature` for a given model (like claude-opus-4-8). */
function tempAwareClient(rejectModel: string) {
  const calls: Array<{ model: string; hasTemp: boolean }> = [];
  const api: MessagesApi = {
    messages: {
      create: async (params: { model: string; temperature?: number }) => {
        const hasTemp = params.temperature !== undefined;
        calls.push({ model: params.model, hasTemp });
        if (params.model === rejectModel && hasTemp) {
          const err = Object.assign(new Error("`temperature` is deprecated for this model."), { status: 400 });
          throw err;
        }
        return toolMessage({ a: "ok" }, "tool_use");
      },
    },
  } as unknown as MessagesApi;
  return { api, calls };
}

describe("LlmClient temperature self-heal", () => {
  it("drops temperature and retries when a model rejects it (400), then returns the result", async () => {
    const fake = tempAwareClient("opus-no-temp");
    const llm = new LlmClient("k", "opus-no-temp", undefined, 0, fake.api);
    const out = await llm.structured<{ a: string }>({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" });
    expect(out).toEqual({ a: "ok" });
    // First call had temperature (rejected), the retry dropped it (succeeded).
    expect(fake.calls).toEqual([
      { model: "opus-no-temp", hasTemp: true },
      { model: "opus-no-temp", hasTemp: false },
    ]);
  });

  it("remembers the model and omits temperature on the NEXT call (no repeat 400)", async () => {
    const fake = tempAwareClient("opus-no-temp");
    const llm = new LlmClient("k", "opus-no-temp", undefined, 0, fake.api);
    await llm.structured({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" }); // self-heals (2 calls)
    await llm.structured({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" }); // should omit temp upfront (1 call)
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]).toEqual({ model: "opus-no-temp", hasTemp: false });
  });

  it("keeps temperature for a model that accepts it", async () => {
    const fake = tempAwareClient("opus-no-temp");
    const llm = new LlmClient("k", "sonnet-ok", undefined, 0, fake.api);
    await llm.structured({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" });
    expect(fake.calls).toEqual([{ model: "sonnet-ok", hasTemp: true }]);
  });

  it("does not swallow a 400 that is unrelated to temperature", async () => {
    const api = {
      messages: {
        create: async () => {
          throw Object.assign(new Error("max_tokens is too large"), { status: 400 });
        },
      },
    } as unknown as MessagesApi;
    const llm = new LlmClient("k", "m", undefined, 0, api);
    await expect(llm.structured({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" })).rejects.toThrow(/max_tokens/);
  });
});

describe("LlmClient.structured truncation retry", () => {
  it("returns the result directly when not truncated", async () => {
    const fake = fakeClient([toolMessage({ a: "ok" }, "tool_use")]);
    const llm = new LlmClient("k", "claude-x", undefined, 0, fake.api);
    const out = await llm.structured<{ a: string }>({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" });
    expect(out).toEqual({ a: "ok" });
    expect(fake.state.calls).toBe(1);
  });

  it("retries once with a bigger budget when the first call hit max_tokens", async () => {
    const fake = fakeClient([toolMessage({ a: "partial" }, "max_tokens"), toolMessage({ a: "complete" }, "tool_use")]);
    const llm = new LlmClient("k", "claude-x", undefined, 0, fake.api);
    const out = await llm.structured<{ a: string }>({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit", maxTokens: 100 });
    expect(out).toEqual({ a: "complete" }); // the retried, complete result
    expect(fake.state.calls).toBe(2);
  });

  it("meters usage for every attempt", async () => {
    const meter = new UsageMeter();
    const fake = fakeClient([toolMessage({ a: "x" }, "max_tokens"), toolMessage({ a: "y" }, "tool_use")]);
    const llm = new LlmClient("k", "claude-x", meter, 0, fake.api);
    await llm.structured({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" });
    expect(meter.totals().total.calls).toBe(2);
  });

  it("gives up after the retry still truncates", async () => {
    const fake = fakeClient([toolMessage({ a: "1" }, "max_tokens"), toolMessage({ a: "2" }, "max_tokens")]);
    const llm = new LlmClient("k", "claude-x", undefined, 0, fake.api);
    // second attempt also max_tokens at attempt===1 -> returns the (still partial) input rather than looping forever
    const out = await llm.structured<{ a: string }>({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" });
    expect(out).toEqual({ a: "2" });
    expect(fake.state.calls).toBe(2);
  });
});

/** A client whose create() throws the given errors in order, then returns `final`. */
function erroringClient(errors: unknown[], final: ReturnType<typeof toolMessage>) {
  let i = 0;
  const state = { calls: 0, sleeps: [] as number[] };
  const api: MessagesApi = {
    messages: {
      create: async () => {
        state.calls++;
        if (i < errors.length) throw errors[i++];
        return final;
      },
    },
  };
  return { api, state };
}
const apiError = (status: number, headers?: Record<string, string>) =>
  Object.assign(new Error(`HTTP ${status}`), { status, ...(headers ? { headers } : {}) });

// No-op sleep that records the delays, fixed rng so backoff is exact (no jitter).
const seam = (sleeps: number[]) => ({ sleep: async (ms: number) => void sleeps.push(ms), rng: () => 0 });

describe("LlmClient retry/backoff", () => {
  it("retries a retriable status (529/503) then succeeds, with exp backoff", async () => {
    const sleeps: number[] = [];
    const fake = erroringClient([apiError(529), apiError(503)], toolMessage({ a: "ok" }, "tool_use"));
    const llm = new LlmClient("k", "x", undefined, 5, fake.api, seam(sleeps));
    const turn = await llm.turn({ system: "s", messages: [] });
    expect(turn.toolUses[0].name).toBe("submit");
    expect(fake.state.calls).toBe(3); // 2 failures + 1 success
    expect(sleeps).toEqual([1000, 2000]); // 1s, 2s exponential (rng=0 -> no jitter)
  });

  it("does not retry a non-retriable status (400) — throws immediately", async () => {
    const sleeps: number[] = [];
    const fake = erroringClient([apiError(400)], toolMessage({ a: "x" }, "tool_use"));
    const llm = new LlmClient("k", "x", undefined, 5, fake.api, seam(sleeps));
    await expect(llm.turn({ system: "s", messages: [] })).rejects.toThrow(/400/);
    expect(fake.state.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const sleeps: number[] = [];
    const fake = erroringClient([apiError(529), apiError(529), apiError(529)], toolMessage({ a: "x" }, "tool_use"));
    const llm = new LlmClient("k", "x", undefined, 2, fake.api, seam(sleeps));
    await expect(llm.turn({ system: "s", messages: [] })).rejects.toThrow(/529/);
    expect(fake.state.calls).toBe(3); // attempts 0,1,2 (maxRetries=2)
    expect(sleeps).toEqual([1000, 2000]); // slept before retries 1 and 2, not after the final failure
  });

  it("honors Retry-After over exponential backoff", async () => {
    const sleeps: number[] = [];
    const fake = erroringClient([apiError(429, { "retry-after": "2" })], toolMessage({ a: "x" }, "tool_use"));
    const llm = new LlmClient("k", "x", undefined, 5, fake.api, seam(sleeps));
    await llm.turn({ system: "s", messages: [] });
    expect(sleeps).toEqual([2000]); // 2s from the header, not the 1s backoff
  });
});

/** A client that 429s for any model in `capped`, else returns a tool message. */
function modelAwareClient(capped: Set<string>, hardFail?: { model: string; status: number }) {
  const calls: string[] = [];
  const api: MessagesApi = {
    messages: {
      create: async (params: { model: string }) => {
        calls.push(params.model);
        if (hardFail && params.model === hardFail.model)
          throw Object.assign(new Error(`HTTP ${hardFail.status}`), { status: hardFail.status });
        if (capped.has(params.model)) throw Object.assign(new Error("HTTP 429"), { status: 429 });
        return toolMessage({ a: "ok" }, "tool_use");
      },
    },
  } as unknown as MessagesApi;
  return { api, calls };
}

describe("LlmClient 429 model fallback", () => {
  it("falls back to a cheaper model when the primary is rate-limited, and reports it", async () => {
    const fake = modelAwareClient(new Set(["primary"]));
    const seen: Array<{ from: string; to: string }> = [];
    const llm = new LlmClient("k", "primary", undefined, 0, fake.api, {
      sleep: async () => {},
      rng: () => 0,
      fallbacks: ["cheap"],
      onFallback: (i) => seen.push(i),
    });
    const out = await llm.structured<{ a: string }>({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" });
    expect(out).toEqual({ a: "ok" });
    expect(fake.calls).toEqual(["primary", "cheap"]); // tried primary, then the fallback
    expect(seen[0]).toMatchObject({ from: "primary", to: "cheap", reason: "HTTP 429" });
  });

  it("walks the ladder until one model works", async () => {
    const fake = modelAwareClient(new Set(["primary", "mid"]));
    const llm = new LlmClient("k", "primary", undefined, 0, fake.api, {
      sleep: async () => {},
      rng: () => 0,
      fallbacks: ["mid", "cheap"],
    });
    const turn = await llm.turn({ system: "s", messages: [] });
    expect(turn.toolUses[0].name).toBe("submit");
    expect(fake.calls).toEqual(["primary", "mid", "cheap"]);
  });

  it("throws the rate-limit error when no fallbacks are configured", async () => {
    const fake = modelAwareClient(new Set(["primary"]));
    const llm = new LlmClient("k", "primary", undefined, 0, fake.api, { sleep: async () => {}, rng: () => 0 });
    await expect(llm.turn({ system: "s", messages: [] })).rejects.toThrow(/429/);
    expect(fake.calls).toEqual(["primary"]);
  });

  it("does NOT fall back on a non-retriable primary error (e.g. 401)", async () => {
    const fake = modelAwareClient(new Set(), { model: "primary", status: 401 });
    const llm = new LlmClient("k", "primary", undefined, 0, fake.api, {
      sleep: async () => {},
      rng: () => 0,
      fallbacks: ["cheap"],
    });
    await expect(llm.turn({ system: "s", messages: [] })).rejects.toThrow(/401/);
    expect(fake.calls).toEqual(["primary"]); // a real error is surfaced, not masked by fallback
  });

  it("surfaces a non-retriable error from a fallback instead of walking past it", async () => {
    // primary 429 → try "bad" which 401s: stop and surface the 401, don't try "cheap".
    const fake = modelAwareClient(new Set(["primary"]), { model: "bad", status: 401 });
    const llm = new LlmClient("k", "primary", undefined, 0, fake.api, {
      sleep: async () => {},
      rng: () => 0,
      fallbacks: ["bad", "cheap"],
    });
    await expect(llm.structured({ system: "s", prompt: "p", schema: SCHEMA, toolName: "submit" })).rejects.toThrow(/401/);
    expect(fake.calls).toEqual(["primary", "bad"]);
  });
});

describe("isRetriableStatus", () => {
  it("retries rate-limit, overloaded and 5xx; not 2xx/4xx", () => {
    for (const s of [429, 529, 500, 503]) expect(isRetriableStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 404]) expect(isRetriableStatus(s)).toBe(false);
    expect(isRetriableStatus(undefined)).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds from a plain-object header", () => {
    expect(retryAfterMs({ headers: { "retry-after": "3" } })).toBe(3000);
  });
  it("reads from a Headers instance", () => {
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "5" }) })).toBe(5000);
  });
  it("caps at 60s and rejects junk/negatives/missing", () => {
    expect(retryAfterMs({ headers: { "retry-after": "120" } })).toBe(60_000);
    expect(retryAfterMs({ headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" } })).toBeNull(); // HTTP-date unsupported
    expect(retryAfterMs({ headers: { "retry-after": "-5" } })).toBeNull();
    expect(retryAfterMs({ headers: {} })).toBeNull();
    expect(retryAfterMs({})).toBeNull();
  });
});
