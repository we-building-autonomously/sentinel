import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { draftSpecs, draftedSuite, type StructuredLlm } from "./draft.js";
import { SuiteSchema } from "./suite.js";
import type { PageProfile } from "./browser/profile.js";

function profile(over: Partial<PageProfile> = {}): PageProfile {
  return {
    url: "https://app.example.com/login",
    title: "Acme — Sign in",
    headings: ["Welcome"],
    forms: [{ fields: ["Email", "Password"], hasPassword: true, submitLabel: "Sign in" }],
    primaryActions: ["Sign in", "Forgot password"],
    hasLogin: true,
    ...over,
  };
}

/** A scripted StructuredLlm that records the prompt and returns canned specs. */
function fakeLlm(specs: unknown): StructuredLlm & { lastPrompt?: string } {
  const obj: StructuredLlm & { lastPrompt?: string } = {
    async structured(opts) {
      obj.lastPrompt = opts.prompt;
      return { specs } as never;
    },
  };
  return obj;
}

describe("draftSpecs", () => {
  it("maps model output into cases and defaults missing tags", async () => {
    const llm = fakeLlm([
      { title: "Login works", task: "Enter creds and submit", intent: "Dashboard shows", tags: ["auth"] },
      { title: "Bad password", task: "Submit a wrong password", intent: "An error is shown" },
    ]);
    const cases = await draftSpecs(llm, profile(), { count: 2 });
    expect(cases).toHaveLength(2);
    expect(cases[0].tags).toEqual(["auth"]);
    expect(cases[1].tags).toEqual(["smoke"]); // defaulted
  });

  it("grounds the prompt in the profile and clamps count to 1..10", async () => {
    const llm = fakeLlm([]);
    await draftSpecs(llm, profile(), { count: 99 });
    expect(llm.lastPrompt).toContain("Email, Password");
    expect(llm.lastPrompt).toContain("A login form is present");
    expect(llm.lastPrompt).toContain("Write 10 test case(s)"); // clamped
  });
});

describe("draftedSuite", () => {
  const cases = [
    { title: "Login works", task: "Enter creds and submit", intent: "Dashboard shows", tags: ["auth", "smoke"] },
  ];

  it("builds a suite with shared app defaults and an auth block for login pages", () => {
    const { suite } = draftedSuite(profile(), cases);
    const defaults = (suite.defaults as any).app;
    expect(defaults.url).toBe("https://app.example.com/login");
    expect(defaults.name).toBe("Acme");
    expect(defaults.auth).toBeDefined();
    expect((suite.specs as unknown[])).toHaveLength(1);
  });

  it("omits auth for a non-login page", () => {
    const { suite } = draftedSuite(profile({ hasLogin: false, forms: [] }), cases);
    expect((suite.defaults as any).app.auth).toBeUndefined();
  });

  it("emits YAML that parses and validates against SuiteSchema", () => {
    const { yaml } = draftedSuite(profile(), cases);
    const parsed = parse(yaml);
    expect(() => SuiteSchema.parse(parsed)).not.toThrow();
    expect(parsed.specs[0].title).toBe("Login works");
    expect(parsed.defaults.app.auth.username).toBeDefined();
  });
});
