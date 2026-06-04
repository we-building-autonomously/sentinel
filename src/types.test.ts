import { describe, it, expect } from "vitest";
import { TestSpecSchema } from "./types.js";

describe("TestSpecSchema", () => {
  it("accepts a minimal valid spec", () => {
    const spec = TestSpecSchema.parse({
      title: "t",
      task: "do x",
      intent: "x happened",
      app: { url: "https://example.com" },
    });
    expect(spec.app.url).toBe("https://example.com");
  });

  it("rejects a non-url app", () => {
    expect(() =>
      TestSpecSchema.parse({ title: "t", task: "x", intent: "y", app: { url: "not-a-url" } })
    ).toThrow();
  });

  it("rejects a missing intent", () => {
    expect(() =>
      TestSpecSchema.parse({ title: "t", task: "x", app: { url: "https://e.com" } })
    ).toThrow();
  });

  it("carries optional auth and criteria through", () => {
    const spec = TestSpecSchema.parse({
      title: "t",
      task: "x",
      intent: "y",
      app: { url: "https://e.com", auth: { username: "a", password: "b" } },
      criteria: ["one", "two"],
      maxSteps: 12,
    });
    expect(spec.app.auth?.username).toBe("a");
    expect(spec.criteria).toEqual(["one", "two"]);
    expect(spec.maxSteps).toBe(12);
  });

  it("parses emulation options and rejects an invalid colorScheme", () => {
    const spec = TestSpecSchema.parse({
      title: "t", task: "x", intent: "y", app: { url: "https://e.com" },
      emulate: { colorScheme: "dark", reducedMotion: "reduce", locale: "fr-FR", timezoneId: "Asia/Tokyo" },
    });
    expect(spec.emulate).toEqual({ colorScheme: "dark", reducedMotion: "reduce", locale: "fr-FR", timezoneId: "Asia/Tokyo" });
    expect(() =>
      TestSpecSchema.parse({ title: "t", task: "x", intent: "y", app: { url: "https://e.com" }, emulate: { colorScheme: "sepia" } })
    ).toThrow();
  });

  it("accepts a frozen clock as an ISO string or epoch number", () => {
    const a = TestSpecSchema.parse({ title: "t", task: "x", intent: "y", app: { url: "https://e.com" }, clock: { now: "2026-01-15T09:00:00Z" } });
    expect(a.clock?.now).toBe("2026-01-15T09:00:00Z");
    const b = TestSpecSchema.parse({ title: "t", task: "x", intent: "y", app: { url: "https://e.com" }, clock: { now: 1700000000000 } });
    expect(b.clock?.now).toBe(1700000000000);
  });
});
