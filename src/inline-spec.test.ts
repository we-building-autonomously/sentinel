import { describe, it, expect } from "vitest";
import { buildInlineSpec, defaultIntent } from "./inline-spec.js";
import { TestSpecSchema } from "./types.js";

describe("buildInlineSpec", () => {
  it("requires a url and a task, with friendly errors", () => {
    expect(buildInlineSpec({}).errors).toEqual([
      "a target URL is required (the first argument)",
      '--task "what the user should do" is required',
    ]);
    expect(buildInlineSpec({ url: "https://x.dev" }).ok).toBe(false);
    expect(buildInlineSpec({ task: "do it" }).ok).toBe(false);
  });

  it("builds a schema-valid spec from a url + task", () => {
    const res = buildInlineSpec({ url: "https://app.dev", task: "log in and open settings" });
    expect(res.ok).toBe(true);
    // The produced object must pass the real TestSpec schema (what runSpec uses).
    const parsed = TestSpecSchema.safeParse(res.spec);
    expect(parsed.success).toBe(true);
    expect(res.spec!.task).toBe("log in and open settings");
  });

  it("derives a default intent and a title from the task when omitted", () => {
    const res = buildInlineSpec({ url: "https://app.dev", task: "buy a widget" });
    expect(res.spec!.intent).toBe(defaultIntent("buy a widget"));
    expect(res.spec!.title).toBe("buy a widget");
  });

  it("truncates a long task into the title but keeps the full task", () => {
    const longTask = "x".repeat(100);
    const res = buildInlineSpec({ url: "https://app.dev", task: longTask });
    expect((res.spec!.title as string).length).toBe(60);
    expect(res.spec!.task).toBe(longTask);
  });

  it("attaches auth only when credentials are given", () => {
    expect(buildInlineSpec({ url: "https://app.dev", task: "t" }).spec!.app).toEqual({ url: "https://app.dev" });
    const withAuth = buildInlineSpec({ url: "https://app.dev", task: "t", user: "me@x.com", pass: "pw" });
    expect((withAuth.spec!.app as Record<string, unknown>).auth).toEqual({ username: "me@x.com", password: "pw" });
  });

  it("passes through a11y, viewport, explicit intent, name and criteria", () => {
    const res = buildInlineSpec({
      url: "https://app.dev",
      task: "t",
      intent: "the dashboard loads",
      name: "Smoke: dashboard",
      a11y: true,
      viewport: "mobile",
      criteria: ["a welcome banner is shown", "  ", "the nav has 4 items"],
    });
    expect(res.spec).toMatchObject({
      title: "Smoke: dashboard",
      intent: "the dashboard loads",
      a11y: true,
      viewport: "mobile",
      criteria: ["a welcome banner is shown", "the nav has 4 items"], // blank dropped
    });
    expect(TestSpecSchema.safeParse(res.spec).success).toBe(true);
  });

  it("passes through expectText / forbidText (trimmed, blanks dropped) as a schema-valid spec", () => {
    const res = buildInlineSpec({
      url: "https://app.dev",
      task: "checkout",
      expectText: ["Order confirmed", "  ", " Total: $40.00 "],
      forbidText: ["undefined", "NaN", ""],
    });
    expect(res.spec!.expectText).toEqual(["Order confirmed", "Total: $40.00"]);
    expect(res.spec!.forbidText).toEqual(["undefined", "NaN"]);
    expect(TestSpecSchema.safeParse(res.spec).success).toBe(true);
  });

  it("omits expectText / forbidText entirely when none are given", () => {
    const res = buildInlineSpec({ url: "https://app.dev", task: "t", expectText: [], forbidText: [] });
    expect(res.spec!.expectText).toBeUndefined();
    expect(res.spec!.forbidText).toBeUndefined();
  });

  it("passes through expectUrl / forbidUrl (trimmed, blanks dropped) as a schema-valid spec", () => {
    const res = buildInlineSpec({
      url: "https://app.dev",
      task: "login",
      expectUrl: ["/dashboard", "  "],
      forbidUrl: [" /login ", ""],
    });
    expect(res.spec!.expectUrl).toEqual(["/dashboard"]);
    expect(res.spec!.forbidUrl).toEqual(["/login"]);
    expect(TestSpecSchema.safeParse(res.spec).success).toBe(true);
  });

  it("rejects an invalid url at the schema layer (runSpec's gate)", () => {
    const res = buildInlineSpec({ url: "not-a-url", task: "t" });
    expect(res.ok).toBe(true); // shape is fine here…
    expect(TestSpecSchema.safeParse(res.spec).success).toBe(false); // …but the schema rejects it
  });
});
