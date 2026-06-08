import { describe, it, expect } from "vitest";
import { collectSpecSecrets, makeScrubber } from "./redact.js";
import type { TestSpec } from "../types.js";

const spec: TestSpec = {
  title: "t",
  task: "log in",
  intent: "reach the dashboard",
  app: {
    url: "https://app.example.com",
    auth: {
      username: "qa@example.com",
      password: "SUPER-SECRET-123",
      totpSecret: "ABCSEEDSEED",
      extra: { adminKey: "xtra-admin-key" },
    },
    headers: { Authorization: "Bearer header-token-xyz" },
    cookies: [{ name: "sid", value: "cookie-secret-val", url: "https://app.example.com" }],
  },
};

describe("collectSpecSecrets", () => {
  it("collects every configured secret value", () => {
    expect(collectSpecSecrets(spec)).toEqual(
      expect.arrayContaining([
        "SUPER-SECRET-123",
        "ABCSEEDSEED",
        "xtra-admin-key",
        "Bearer header-token-xyz",
        "cookie-secret-val",
      ])
    );
  });

  it("does not mutate the spec", () => {
    const before = JSON.stringify(spec);
    collectSpecSecrets(spec);
    expect(JSON.stringify(spec)).toBe(before);
  });

  it("returns nothing for a spec with no credentials", () => {
    expect(collectSpecSecrets({ title: "t", task: "x", intent: "y", app: { url: "http://x" } })).toEqual([]);
  });
});

describe("makeScrubber", () => {
  it("masks a known secret echoed in a live step summary", () => {
    const scrub = makeScrubber(collectSpecSecrets(spec));
    const masked = scrub('Typed "SUPER-SECRET-123" into [1]');
    expect(masked).not.toContain("SUPER-SECRET-123");
    expect(masked).toContain("••••••");
  });

  it("also masks secret-shaped tokens the app reveals (not in the spec)", () => {
    const scrub = makeScrubber([]);
    // A JWT the page displayed — caught by shape, not by the known list.
    const out = scrub("token: eyJhbGciOiJIUzI1Ni9.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fwpM");
    expect(out).not.toContain("eyJhbGciOiJIUzI1Ni9");
  });

  it("leaves ordinary text untouched", () => {
    const scrub = makeScrubber(["SUPER-SECRET-123"]);
    expect(scrub('Clicked "Save"')).toBe('Clicked "Save"');
  });
});
