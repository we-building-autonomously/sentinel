import { describe, it, expect } from "vitest";
import { renderTemplate, applyTemplates, makeContext, withVars } from "./template.js";

/** Deterministic context: fixed clock + a simple repeatable PRNG. */
function ctx(env: Record<string, string> = {}) {
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return makeContext({ now: 1_700_000_000_000, rand, env });
}

describe("makeContext", () => {
  it("produces stable values for a fixed clock/rng, reused within a run", () => {
    const c = ctx();
    expect(c.timestamp).toBe("1700000000000");
    expect(c.randomEmail).toContain("qa+");
    expect(c.randomEmail).toContain("@example.com");
    expect(c.randomString).toHaveLength(8);
    expect(c.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("renderTemplate", () => {
  it("substitutes known tokens", () => {
    const c = ctx();
    expect(renderTemplate("Sign up as {{randomEmail}}", c)).toBe(`Sign up as ${c.randomEmail}`);
    expect(renderTemplate("ts={{timestamp}}", c)).toBe("ts=1700000000000");
  });

  it("reuses the same value for a token used twice", () => {
    const c = ctx();
    const out = renderTemplate("{{randomEmail}} ... {{randomEmail}}", c);
    const [a, b] = out.split(" ... ");
    expect(a).toBe(b);
  });

  it("resolves {{env.NAME}} and leaves unknown env intact", () => {
    const c = ctx({ BASE_URL: "https://staging.example.com" });
    expect(renderTemplate("{{env.BASE_URL}}/login", c)).toBe("https://staging.example.com/login");
    expect(renderTemplate("{{env.NOPE}}", c)).toBe("{{env.NOPE}}");
  });

  it("leaves unknown tokens untouched (surfaces typos)", () => {
    expect(renderTemplate("{{notAThing}}", ctx())).toBe("{{notAThing}}");
  });

  it("resolves per-case vars and lets them take precedence over built-ins", () => {
    const c = withVars(ctx(), { card: "4111111111111111", randomEmail: "fixed@case.com" });
    expect(renderTemplate("Pay with {{card}}", c)).toBe("Pay with 4111111111111111");
    expect(renderTemplate("{{randomEmail}}", c)).toBe("fixed@case.com"); // case var wins
  });
});

describe("withVars", () => {
  it("merges vars without mutating the base context", () => {
    const base = ctx();
    const a = withVars(base, { x: "1" });
    const b = withVars(a, { y: "2" });
    expect(base.vars).toBeUndefined();
    expect(a.vars).toEqual({ x: "1" });
    expect(b.vars).toEqual({ x: "1", y: "2" });
  });
});

describe("applyTemplates", () => {
  it("deep-renders string leaves in a spec, leaving non-strings", () => {
    const c = ctx({ BASE_URL: "https://app.test" });
    const spec = {
      title: "Signup",
      task: "Register {{randomEmail}}",
      app: { url: "{{env.BASE_URL}}/signup", auth: { username: "{{randomEmail}}", password: "Pw-{{randomString}}" } },
      maxSteps: 20,
      tags: ["smoke", "{{timestamp}}"],
    };
    const out = applyTemplates(spec, c) as typeof spec;
    expect(out.task).toBe(`Register ${c.randomEmail}`);
    expect(out.app.url).toBe("https://app.test/signup");
    expect(out.app.auth.username).toBe(c.randomEmail);
    expect(out.app.auth.password).toBe(`Pw-${c.randomString}`);
    expect(out.maxSteps).toBe(20); // numbers untouched
    expect(out.tags[1]).toBe("1700000000000");
  });
});
