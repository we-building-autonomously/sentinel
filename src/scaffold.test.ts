import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { scaffoldSpec } from "./scaffold.js";
import type { PageProfile } from "./browser/profile.js";

function profile(over: Partial<PageProfile> = {}): PageProfile {
  return {
    url: "https://app.example.com/login",
    title: "Example App — Sign in",
    headings: ["Welcome back"],
    forms: [],
    primaryActions: [],
    hasLogin: false,
    ...over,
  };
}

describe("scaffoldSpec — login page", () => {
  const p = profile({
    forms: [{ fields: ["Email", "Password"], hasPassword: true, submitLabel: "Sign in" }],
    primaryActions: ["Sign in", "Forgot password"],
    hasLogin: true,
  });
  const { spec, yaml } = scaffoldSpec(p);

  it("derives an app name from the title and tags it auth", () => {
    expect((spec.app as any).name).toBe("Example App");
    expect(spec.tags).toContain("auth");
    expect(spec.tags).toContain("smoke");
  });

  it("scaffolds an auth block with placeholders", () => {
    expect((spec.app as any).auth).toMatchObject({ username: expect.any(String), password: "TODO" });
  });

  it("references the real form fields and submit label in the task", () => {
    expect(spec.task).toContain("Email, Password");
    expect(spec.task).toContain("Sign in");
  });

  it("emits valid YAML that round-trips to the same core fields", () => {
    const parsed = parse(yaml);
    expect(parsed.title).toBe(spec.title);
    expect(parsed.app.url).toBe(p.url);
    expect(parsed.app.auth.username).toBeDefined();
  });

  it("includes detected page details as reference comments", () => {
    expect(yaml).toContain("# headings: Welcome back");
    expect(yaml).toContain("# form: [Email, Password] (has password)");
  });
});

describe("scaffoldSpec — non-login page", () => {
  const p = profile({
    url: "https://shop.example.com",
    title: "Shop",
    headings: ["Today's deals"],
    primaryActions: ["Add to cart", "Checkout"],
    hasLogin: false,
  });
  const { spec, yaml } = scaffoldSpec(p);

  it("leaves task/intent as grounded TODOs and no auth block", () => {
    expect(spec.task).toContain("TODO");
    expect(spec.task).toContain("Add to cart");
    expect((spec.app as any).auth).toBeUndefined();
    expect(spec.tags).not.toContain("auth");
  });

  it("honors an explicit name override", () => {
    const { spec: s2 } = scaffoldSpec(p, { name: "My Shop" });
    expect((s2.app as any).name).toBe("My Shop");
    expect(s2.title).toContain("My Shop");
  });

  it("produces parseable YAML", () => {
    expect(() => parse(yaml)).not.toThrow();
  });
});
