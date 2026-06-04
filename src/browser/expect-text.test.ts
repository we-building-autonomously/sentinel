import { describe, it, expect } from "vitest";
import { evaluateTextExpectations } from "./expect-text.js";

describe("evaluateTextExpectations", () => {
  const page = "Order confirmed. Total: $40.00. Thanks, Ada!";

  it("present: met when the required text is found", () => {
    const [a, b] = evaluateTextExpectations(page, { expect: ["Order confirmed", "Total: $40.00"] });
    expect(a.met).toBe(true);
    expect(b.met).toBe(true);
  });

  it("present: UNMET when required text is missing", () => {
    const [r] = evaluateTextExpectations(page, { expect: ["Order shipped"] });
    expect(r).toMatchObject({ kind: "present", found: false, met: false });
    expect(r.detail).toMatch(/UNMET/);
  });

  it("absent: met when forbidden text is not present", () => {
    const [r] = evaluateTextExpectations(page, { forbid: ["undefined"] });
    expect(r).toMatchObject({ kind: "absent", found: false, met: true });
  });

  it("absent: UNMET when forbidden text leaks onto the page", () => {
    const broken = "Welcome, undefined! Your balance is NaN.";
    const checks = evaluateTextExpectations(broken, { forbid: ["undefined", "NaN", "{{name}}"] });
    expect(checks.find((c) => c.text === "undefined")!.met).toBe(false);
    expect(checks.find((c) => c.text === "NaN")!.met).toBe(false);
    expect(checks.find((c) => c.text === "{{name}}")!.met).toBe(true); // not present
  });

  it("is case-SENSITIVE so forbidding 'NaN' does not trip on 'banana'", () => {
    const [r] = evaluateTextExpectations("I love banana bread", { forbid: ["NaN"] });
    expect(r.met).toBe(true); // 'NaN' (caps) not in 'banana'
  });

  it("normalizes whitespace so multi-space copy still matches", () => {
    const [r] = evaluateTextExpectations("Total:   $40.00", { expect: ["Total: $40.00"] });
    expect(r.met).toBe(true);
  });

  it("ignores blank needles", () => {
    expect(evaluateTextExpectations(page, { expect: ["   "] })[0].met).toBe(false);
  });
});
