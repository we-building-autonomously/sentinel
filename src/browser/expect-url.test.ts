import { describe, it, expect } from "vitest";
import { evaluateUrlExpectations } from "./expect-url.js";

describe("evaluateUrlExpectations", () => {
  const URL = "https://app.example.com/dashboard?welcome=1#top";

  it("is empty when nothing is declared", () => {
    expect(evaluateUrlExpectations(URL, {})).toEqual([]);
  });

  it("expectUrl: met when the substring is in the URL, unmet otherwise", () => {
    const r = evaluateUrlExpectations(URL, { expect: ["/dashboard", "/billing"] });
    expect(r[0]).toMatchObject({ kind: "contains", text: "/dashboard", found: true, met: true });
    expect(r[1]).toMatchObject({ kind: "contains", text: "/billing", found: false, met: false });
  });

  it("matches against query and hash, not just the path", () => {
    expect(evaluateUrlExpectations(URL, { expect: ["welcome=1"] })[0].met).toBe(true);
    expect(evaluateUrlExpectations(URL, { expect: ["#top"] })[0].met).toBe(true);
  });

  it("forbidUrl: met when the substring is absent, unmet when present", () => {
    const r = evaluateUrlExpectations(URL, { forbid: ["/login", "welcome=1"] });
    expect(r[0]).toMatchObject({ kind: "excludes", text: "/login", found: false, met: true });
    expect(r[1]).toMatchObject({ kind: "excludes", text: "welcome=1", found: true, met: false });
  });

  it("is case-sensitive and trims declared values", () => {
    expect(evaluateUrlExpectations(URL, { expect: ["/Dashboard"] })[0].met).toBe(false);
    expect(evaluateUrlExpectations(URL, { expect: ["  /dashboard  "] })[0].met).toBe(true);
  });

  it("treats a missing final URL as 'nothing present' (expect fails, forbid passes)", () => {
    expect(evaluateUrlExpectations(undefined, { expect: ["/x"] })[0].met).toBe(false);
    expect(evaluateUrlExpectations(undefined, { forbid: ["/x"] })[0].met).toBe(true);
  });

  it("ignores empty/whitespace declared values", () => {
    expect(evaluateUrlExpectations(URL, { expect: ["   "] })[0].met).toBe(false);
  });
});
