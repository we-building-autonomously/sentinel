import { describe, it, expect } from "vitest";
import { summarizeAxe, formatA11y } from "./a11y.js";

const raw = {
  violations: [
    { id: "image-alt", impact: "critical", help: "Images must have alt text", nodes: [{ target: ["img.logo"] }, { target: ["#hero > img"] }] },
    { id: "color-contrast", impact: "serious", help: "Elements must have sufficient contrast", nodes: [{ target: [".muted"] }] },
    { id: "region", impact: "moderate", help: "All content in landmarks", nodes: [{}, {}, {}] },
    { id: "weird", impact: null, help: "no impact given", nodes: [{}] },
  ],
};

describe("summarizeAxe", () => {
  it("maps violations, counts by impact and totals affected nodes", () => {
    const r = summarizeAxe(raw);
    expect(r.violations).toHaveLength(4);
    expect(r.counts).toEqual({ critical: 1, serious: 1, moderate: 1, minor: 1 }); // null impact -> minor
    expect(r.total).toBe(7);
  });

  it("sorts violations by impact severity (critical first)", () => {
    const r = summarizeAxe(raw);
    expect(r.violations.map((v) => v.impact)).toEqual(["critical", "serious", "moderate", "minor"]);
    expect(r.violations[0].id).toBe("image-alt");
  });

  it("handles a clean page", () => {
    const r = summarizeAxe({ violations: [] });
    expect(r.violations).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it("extracts CSS selectors of affected nodes (capped), tolerating missing targets", () => {
    const r = summarizeAxe(raw);
    const imgAlt = r.violations.find((v) => v.id === "image-alt")!;
    expect(imgAlt.selectors).toEqual(["img.logo", "#hero > img"]);
    // nodes without a target yield no selectors
    expect(r.violations.find((v) => v.id === "region")!.selectors).toEqual([]);
  });
});

describe("formatA11y", () => {
  it("summarizes counts by impact", () => {
    expect(formatA11y(summarizeAxe(raw))).toBe("4 violation(s): 1 critical, 1 serious, 1 moderate, 1 minor");
  });
  it("says 'no violations' when clean", () => {
    expect(formatA11y(summarizeAxe({ violations: [] }))).toBe("no violations");
  });
});
