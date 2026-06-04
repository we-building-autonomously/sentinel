import { describe, it, expect } from "vitest";
import { validateSpecData } from "./validate.js";
import { makeContext } from "./template.js";

const ctx = makeContext({ now: 1, rand: () => 0.4, env: { APP_URL: "https://app.test" } });

describe("validateSpecData — single spec", () => {
  it("accepts a valid spec", () => {
    const r = validateSpecData({ title: "t", task: "x", intent: "y", app: { url: "https://e.com" } }, ctx);
    expect(r).toMatchObject({ kind: "spec", ok: true, errors: [] });
  });

  it("reports a missing field and a bad url with paths", () => {
    const r = validateSpecData({ title: "t", task: "x", app: { url: "not-a-url" } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/intent/);
    expect(r.errors.join("\n")).toMatch(/app\.url/);
  });

  it("resolves {{env.X}} before validating the url", () => {
    const r = validateSpecData({ title: "t", task: "x", intent: "y", app: { url: "{{env.APP_URL}}/login" } }, ctx);
    expect(r.ok).toBe(true);
  });

  it("treats an unresolved-template url as deferred (valid), not a structural error", () => {
    const noEnv = makeContext({ now: 1, rand: () => 0.4, env: {} });
    const r = validateSpecData({ title: "t", task: "x", intent: "y", app: { url: "{{env.MISSING}}" } }, noEnv);
    expect(r.ok).toBe(true);
  });

  it("warns (but stays valid) on a typo'd top-level field that zod would silently strip", () => {
    const r = validateSpecData(
      { title: "t", task: "x", intent: "y", app: { url: "https://e.com" }, forbidTex: ["undefined"] },
      ctx
    );
    expect(r.ok).toBe(true); // unknown key is non-fatal
    expect(r.warnings.join("\n")).toMatch(/unknown field "forbidTex"/);
  });

  it("warns on a typo'd app field", () => {
    const r = validateSpecData(
      { title: "t", task: "x", intent: "y", app: { url: "https://e.com", notez: "oops" } },
      ctx
    );
    expect(r.warnings.join("\n")).toMatch(/app\.unknown field "notez"/);
  });

  it("emits no warnings for a clean spec using real fields", () => {
    const r = validateSpecData(
      { title: "t", task: "x", intent: "y", app: { url: "https://e.com" }, forbidText: ["x"], security: true },
      ctx
    );
    expect(r.warnings).toEqual([]);
  });
});

describe("validateSpecData — suite", () => {
  it("accepts a valid suite", () => {
    const r = validateSpecData(
      { name: "s", defaults: { app: { url: "https://e.com" } }, specs: [{ title: "a", task: "x", intent: "y" }] },
      ctx
    );
    expect(r).toMatchObject({ kind: "suite", ok: true });
  });

  it("catches a spec-level error that SuiteSchema alone would miss", () => {
    // SuiteSchema.specs is opaque records; the missing `intent` is only caught
    // by validating each spec against TestSpecSchema after defaults.
    const r = validateSpecData(
      { name: "s", defaults: { app: { url: "https://e.com" } }, specs: [{ title: "a", task: "x" /* no intent */ }] },
      ctx
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/spec\[0\].*intent/s);
  });

  it("validates the login spec too", () => {
    const r = validateSpecData(
      {
        name: "s",
        defaults: { app: { url: "https://e.com" } },
        login: { title: "login", task: "x" }, // missing intent
        specs: [{ title: "a", task: "x", intent: "y" }],
      },
      ctx
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/login →/);
  });

  it("flags a structural suite error (empty specs)", () => {
    const r = validateSpecData({ name: "s", specs: [] }, ctx);
    expect(r.ok).toBe(false);
  });
});
