import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { applyDefaults, runSuite, expandMatrix, expandCases } from "./suite.js";
import { makeContext } from "./template.js";
import type { RunReport } from "./types.js";
import type { RunOptions } from "./runner.js";

describe("applyDefaults", () => {
  const defaults = {
    app: {
      url: "https://app.example.com",
      auth: { username: "shared@example.com", password: "pw", extra: { tenant: "acme" } },
    },
    maxSteps: 25,
  };

  it("fills url and auth from defaults when spec omits them", () => {
    const merged = applyDefaults({ title: "t", task: "x", intent: "y" }, defaults) as any;
    expect(merged.app.url).toBe("https://app.example.com");
    expect(merged.app.auth.username).toBe("shared@example.com");
    expect(merged.maxSteps).toBe(25);
  });

  it("lets spec-level fields win over defaults", () => {
    const merged = applyDefaults(
      { title: "t", task: "x", intent: "y", app: { url: "https://other.com" }, maxSteps: 5 },
      defaults
    ) as any;
    expect(merged.app.url).toBe("https://other.com");
    expect(merged.maxSteps).toBe(5);
    // auth still inherited since spec didn't override it
    expect(merged.app.auth.username).toBe("shared@example.com");
  });

  it("deep-merges auth.extra", () => {
    const merged = applyDefaults(
      { title: "t", task: "x", intent: "y", app: { auth: { extra: { role: "admin" } } } },
      defaults
    ) as any;
    expect(merged.app.auth.extra).toEqual({ tenant: "acme", role: "admin" });
  });

  it("is a no-op without defaults", () => {
    const raw = { title: "t", app: { url: "u" } };
    expect(applyDefaults(raw, undefined)).toBe(raw);
  });
});

function fakeReport(title: string, decision: RunReport["verdict"]["decision"] = "pass"): RunReport {
  return {
    spec: { title, task: "x", intent: "y", app: { url: "https://e.com" } },
    plan: { goal: "g", checkpoints: [] },
    steps: [],
    verdict: { decision, confidence: 1, summary: "ok", checkpoints: [], issues: [] },
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:00Z",
    durationMs: 1,
    runDir: "",
  };
}

describe("runSuite", () => {
  const suite = {
    name: "smoke",
    concurrency: 2,
    defaults: { app: { url: "https://app.example.com" } },
    specs: [
      { title: "a", task: "x", intent: "y" },
      { title: "b", task: "x", intent: "y" },
      { title: "c", task: "x", intent: "y" },
    ],
  };

  it("runs every spec through the injected runner with defaults applied", async () => {
    const seen: string[] = [];
    const reports = await runSuite(suite, {
      runner: async (spec: any) => {
        seen.push(spec.title);
        expect(spec.app.url).toBe("https://app.example.com");
        return fakeReport(spec.title);
      },
    });
    expect(reports).toHaveLength(3);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  it("runs only the requested shard's specs (and the union covers all)", async () => {
    const run = async (shard: { index: number; total: number }) => {
      const seen: string[] = [];
      await runSuite(suite, { shard, runner: async (spec: any) => (seen.push(spec.title), fakeReport(spec.title)) });
      return seen.sort();
    };
    const s1 = await run({ index: 1, total: 2 });
    const s2 = await run({ index: 2, total: 2 });
    // No overlap, full coverage of a,b,c across the two shards.
    expect(s1.filter((t) => s2.includes(t))).toEqual([]);
    expect([...s1, ...s2].sort()).toEqual(["a", "b", "c"]);
  });

  it("isolates a crashing spec as an inconclusive report", async () => {
    const reports = await runSuite(suite, {
      runner: async (spec: any) => {
        if (spec.title === "b") throw new Error("boom");
        return fakeReport(spec.title);
      },
    });
    const b = reports.find((r) => r.spec.title === "b")!;
    expect(b.verdict.decision).toBe("inconclusive");
    expect(b.verdict.summary).toContain("boom");
    // other specs still pass
    expect(reports.filter((r) => r.verdict.decision === "pass")).toHaveLength(2);
  });

  it("rejects a malformed suite", async () => {
    await expect(runSuite({ name: "x", specs: [] }, { runner: async () => fakeReport("z") })).rejects.toThrow();
  });
});

describe("expandMatrix", () => {
  const specs = [
    { title: "Login", task: "x", intent: "y" },
    { title: "Checkout", task: "x", intent: "y" },
  ];

  it("returns specs unchanged with no matrix", () => {
    expect(expandMatrix(specs, undefined)).toBe(specs);
    expect(expandMatrix(specs, { viewport: [] })).toBe(specs);
  });

  it("clones each spec per viewport with a suffixed title", () => {
    const out = expandMatrix(specs, { viewport: ["desktop", "mobile"] });
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.title)).toEqual([
      "Login [desktop]",
      "Login [mobile]",
      "Checkout [desktop]",
      "Checkout [mobile]",
    ]);
    expect(out[1].viewport).toBe("mobile");
  });

  it("expands a colorScheme axis into emulate.colorScheme", () => {
    const out = expandMatrix([{ title: "Home", task: "x" }], { colorScheme: ["light", "dark"] });
    expect(out.map((s) => s.title)).toEqual(["Home [light]", "Home [dark]"]);
    expect(out[1].emulate).toEqual({ colorScheme: "dark" });
  });

  it("takes the cartesian product across viewport × colorScheme × locale", () => {
    const out = expandMatrix([{ title: "Buy", task: "x" }], {
      viewport: ["desktop", "mobile"],
      colorScheme: ["light", "dark"],
      locale: ["en-US", "fr-FR"],
    });
    expect(out).toHaveLength(8); // 2 × 2 × 2
    expect(out[0].title).toBe("Buy [desktop · light · en-US]");
    expect(out[7].title).toBe("Buy [mobile · dark · fr-FR]");
    // The last combo set all three fields.
    expect(out[7].viewport).toBe("mobile");
    expect(out[7].emulate).toEqual({ colorScheme: "dark", locale: "fr-FR" });
  });

  it("merges matrix emulation onto a spec's own emulate without clobbering it", () => {
    const out = expandMatrix([{ title: "T", emulate: { reducedMotion: "reduce" } }], { colorScheme: ["dark"] });
    expect(out[0].emulate).toEqual({ reducedMotion: "reduce", colorScheme: "dark" });
  });

  it("is unchanged when every axis is empty", () => {
    expect(expandMatrix(specs, { viewport: [], colorScheme: [], locale: [] })).toBe(specs);
  });
});

describe("expandCases", () => {
  it("returns the spec unchanged (sans cases key) with no cases", () => {
    expect(expandCases({ title: "A", task: "t" })).toEqual([{ spec: { title: "A", task: "t" }, vars: {} }]);
    expect(expandCases({ title: "A", cases: [] })).toEqual([{ spec: { title: "A" }, vars: {} }]);
  });

  it("clones a spec per case with a [name] title suffix and string vars", () => {
    const out = expandCases({
      title: "Pay",
      task: "Pay with {{card}}",
      cases: [
        { name: "visa", card: "4111", expect: "Approved" },
        { name: "declined", card: "4000", expect: "Declined" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].spec.title).toBe("Pay [visa]");
    expect(out[0].spec).not.toHaveProperty("cases");
    expect(out[0].vars).toEqual({ name: "visa", card: "4111", expect: "Approved" });
    expect(out[1].spec.title).toBe("Pay [declined]");
  });

  it("falls back to a 1-based index when a case has no name", () => {
    const out = expandCases({ title: "T", cases: [{ a: "x" }, { a: "y" }] });
    expect(out.map((o) => o.spec.title)).toEqual(["T [1]", "T [2]"]);
  });
});

describe("runSuite data-driven cases", () => {
  it("runs one spec per case with the case's vars interpolated into the fields", async () => {
    const seen: Array<{ title: string; task: string }> = [];
    const reports = await runSuite(
      {
        name: "cards",
        defaults: { app: { url: "https://shop.test" } },
        specs: [
          {
            title: "Checkout",
            task: "Pay with {{card}}",
            intent: "payment {{expect}}",
            expectText: ["{{expect}}"],
            cases: [
              { name: "visa", card: "4111", expect: "Approved" },
              { name: "declined", card: "4000", expect: "Declined" },
            ],
          },
        ],
      },
      {
        runner: async (spec: any) => {
          seen.push({ title: spec.title, task: spec.task });
          expect(spec.app.url).toBe("https://shop.test");
          return fakeReport(spec.title);
        },
      }
    );
    expect(reports).toHaveLength(2);
    expect(seen).toContainEqual({ title: "Checkout [visa]", task: "Pay with 4111" });
    expect(seen).toContainEqual({ title: "Checkout [declined]", task: "Pay with 4000" });
  });
});

describe("runSuite matrix", () => {
  it("runs every spec across each matrix viewport", async () => {
    const seen: Array<{ title: string; viewport: unknown }> = [];
    const reports = await runSuite(
      {
        name: "matrix suite",
        matrix: { viewport: ["desktop", "mobile"] },
        defaults: { app: { url: "https://app.example.com" } },
        specs: [{ title: "Home", task: "x", intent: "y" }],
      },
      {
        runner: async (spec: any) => {
          seen.push({ title: spec.title, viewport: spec.viewport });
          return fakeReport(spec.title);
        },
      }
    );
    expect(reports).toHaveLength(2);
    expect(seen).toEqual([
      { title: "Home [desktop]", viewport: "desktop" },
      { title: "Home [mobile]", viewport: "mobile" },
    ]);
  });

  it("runs the cartesian product and passes emulation through to each run", async () => {
    const seen: Array<{ title: string; viewport: unknown; emulate: unknown }> = [];
    const reports = await runSuite(
      {
        name: "cross-cutting",
        matrix: { viewport: ["mobile"], colorScheme: ["light", "dark"], locale: ["fr-FR"] },
        defaults: { app: { url: "https://app.example.com" } },
        specs: [{ title: "Home", task: "x", intent: "y" }],
      },
      {
        runner: async (spec: any) => {
          seen.push({ title: spec.title, viewport: spec.viewport, emulate: spec.emulate });
          return fakeReport(spec.title);
        },
      }
    );
    expect(reports).toHaveLength(2);
    expect(seen).toEqual([
      { title: "Home [mobile · light · fr-FR]", viewport: "mobile", emulate: { colorScheme: "light", locale: "fr-FR" } },
      { title: "Home [mobile · dark · fr-FR]", viewport: "mobile", emulate: { colorScheme: "dark", locale: "fr-FR" } },
    ]);
  });
});

function costReport(title: string, costUsd: number): RunReport {
  const r = fakeReport(title, "pass");
  r.usage = { byModel: {}, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }, costUsd };
  return r;
}

describe("runSuite cost budget", () => {
  const suite = (n: number) => ({
    name: "budgeted",
    concurrency: 1, // deterministic: one at a time
    defaults: { app: { url: "https://e.com" } },
    specs: Array.from({ length: n }, (_, i) => ({ title: `s${i}`, task: "x", intent: "y" })),
  });

  it("stops launching specs once the budget is reached", async () => {
    let ran = 0;
    const reports = await runSuite(suite(5), {
      budgetUsd: 0.25, // each run costs 0.10 -> allows s0,s1,s2 (spent crosses 0.25 after s2), skips the rest
      runner: async (spec: any) => {
        ran++;
        return costReport(spec.title, 0.1);
      },
    });
    const skipped = reports.filter((r) => r.verdict.summary.includes("cost budget"));
    expect(ran).toBeLessThan(5);
    expect(skipped.length).toBeGreaterThan(0);
    // every spec still appears in the output (run or skipped)
    expect(reports).toHaveLength(5);
    // Budget-skipped specs are triaged as 'skipped' (not run), not 'app-unavailable'.
    expect(skipped.every((r) => r.triage?.category === "skipped")).toBe(true);
  });

  it("runs everything when the budget is generous", async () => {
    let ran = 0;
    await runSuite(suite(3), {
      budgetUsd: 100,
      runner: async (spec: any) => (ran++, costReport(spec.title, 0.1)),
    });
    expect(ran).toBe(3);
  });

  it("runs everything when no budget is set", async () => {
    let ran = 0;
    await runSuite(suite(3), { runner: async (spec: any) => (ran++, costReport(spec.title, 99)) });
    expect(ran).toBe(3);
  });
});

describe("runSuite shared templating", () => {
  it("resolves {{templates}} once so login-once and the specs share the data", async () => {
    const seen: Record<string, string> = {};
    const reports = await runSuite(
      {
        name: "templated",
        defaults: { app: { url: "https://app.example.com" } },
        login: { title: "signup", task: "sign up as {{randomEmail}}", intent: "account created" },
        specs: [
          { title: "view profile", task: "open profile for {{randomEmail}}", intent: "y" },
          { title: "edit settings {{randomString}}", task: "x", intent: "y" },
        ],
      },
      {
        runner: async (spec: any, opts) => {
          // Login provides the state; the login + every spec must see the SAME email.
          const email = spec.task.match(/qa\+[a-z0-9]+@example\.com/)?.[0] ?? spec.task;
          seen[spec.title] = email;
          if (opts.saveStorageStateTo) return fakeReport(spec.title, "pass");
          return fakeReport(spec.title, "pass");
        },
      }
    );
    expect(reports).toHaveLength(3); // login + 2 specs
    // The login spec's email and the first spec's email are identical.
    const loginEmail = seen["signup"];
    expect(loginEmail).toMatch(/qa\+[a-z0-9]+@example\.com/);
    expect(seen["view profile"]).toBe(loginEmail);
  });

  it("uses an injected context for fully deterministic data", async () => {
    const ctx = makeContext({ now: 1, rand: () => 0.5 });
    const seen: string[] = [];
    await runSuite(
      {
        name: "t",
        defaults: { app: { url: "https://e.com" } },
        specs: [{ title: "a", task: "{{randomEmail}}", intent: "y" }, { title: "b", task: "{{randomEmail}}", intent: "y" }],
      },
      { templateContext: ctx, runner: async (s: any) => (seen.push(s.task), fakeReport(s.title)) }
    );
    expect(seen[0]).toBe(ctx.randomEmail);
    expect(seen[1]).toBe(ctx.randomEmail); // both specs share the one context
  });
});

describe("runSuite login-once", () => {
  const loginSuite = {
    name: "auth flow",
    defaults: { app: { url: "https://app.example.com", auth: { username: "u", password: "p" } } },
    login: { title: "log in", task: "log in", intent: "dashboard shows" },
    specs: [
      { title: "view profile", task: "x", intent: "y" },
      { title: "edit settings", task: "x", intent: "y" },
    ],
  };

  it("runs login first and threads its storageState into every spec", async () => {
    const received: Record<string, string | undefined> = {};
    const reports = await runSuite(loginSuite, {
      runner: async (spec: any, opts: RunOptions) => {
        if (opts.saveStorageStateTo) {
          fs.writeFileSync(opts.saveStorageStateTo, "{}"); // simulate captured auth
          return fakeReport(spec.title, "pass");
        }
        received[spec.title] = opts.storageState;
        return fakeReport(spec.title, "pass");
      },
    });
    // login report + 2 spec reports
    expect(reports).toHaveLength(3);
    expect(reports[0].spec.title).toBe("log in");
    // both specs got the same shared state path
    const paths = Object.values(received);
    expect(paths[0]).toBeTruthy();
    expect(new Set(paths).size).toBe(1);
  });

  it("skips the suite when shared login fails", async () => {
    const reports = await runSuite(loginSuite, {
      runner: async (spec: any, opts: RunOptions) => {
        if (opts.saveStorageStateTo) return fakeReport(spec.title, "fail");
        return fakeReport(spec.title, "pass"); // should never run
      },
    });
    expect(reports[0].verdict.decision).toBe("fail");
    expect(reports.slice(1).every((r) => r.verdict.decision === "inconclusive")).toBe(true);
    expect(reports[1].verdict.summary).toContain("Skipped");
    // Dependents are triaged 'skipped' (not run), so the suite rollup, Slack and
    // JUnit show them correctly — not as a flood of 'app-unavailable'.
    expect(reports.slice(1).every((r) => r.triage?.category === "skipped")).toBe(true);
  });
});
