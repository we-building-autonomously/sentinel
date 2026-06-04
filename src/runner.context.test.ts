import { describe, it, expect } from "vitest";
import { buildContext, resolveClock } from "./runner.js";
import type { TestSpec } from "./types.js";

function spec(over: Partial<TestSpec> = {}): TestSpec {
  return { title: "t", task: "x", intent: "y", app: { url: "https://e.com" }, ...over } as TestSpec;
}

describe("buildContext", () => {
  it("is undefined when there's nothing to say", () => {
    expect(buildContext(spec())).toBeUndefined();
  });

  it("includes credentials and the 2FA hint", () => {
    const ctx = buildContext(spec({ app: { url: "https://e.com", auth: { username: "u@e.com", password: "pw", totpSecret: "SEED" } } }))!;
    expect(ctx).toContain("Username/email: u@e.com");
    expect(ctx).toContain("Password: pw");
    expect(ctx).toMatch(/get_totp tool/);
  });

  it("describes active emulation so the agent expects a localized/dark UI", () => {
    const ctx = buildContext(spec({ emulate: { colorScheme: "dark", locale: "fr-FR", timezoneId: "Asia/Tokyo" } }))!;
    expect(ctx).toMatch(/dark mode/);
    expect(ctx).toMatch(/locale fr-FR/);
    expect(ctx).toMatch(/timezone Asia\/Tokyo/);
  });

  it("says nothing about emulation when it would be the default (light, no reduced motion)", () => {
    expect(buildContext(spec({ emulate: { colorScheme: "light" } }))).toBeUndefined();
  });

  it("tells the agent when the clock is frozen", () => {
    const ctx = buildContext(spec({ clock: { now: "2030-03-15T12:00:00Z" } }))!;
    expect(ctx).toMatch(/clock is frozen to 2030-03-15T12:00:00/);
    expect(ctx).toMatch(/treat that as "now"/);
  });
});

describe("resolveClock", () => {
  it("passes through an epoch-ms number", () => {
    expect(resolveClock(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
  it("parses an ISO-8601 string to epoch ms", () => {
    expect(resolveClock("2030-03-15T12:00:00.000Z")).toBe(Date.parse("2030-03-15T12:00:00.000Z"));
  });
  it("is undefined for missing or unparseable input", () => {
    expect(resolveClock(undefined)).toBeUndefined();
    expect(resolveClock("not a date")).toBeUndefined();
  });
});
