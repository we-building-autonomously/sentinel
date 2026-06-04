import { describe, it, expect } from "vitest";
import { renderElements, type ElementInfo } from "./indexer.js";

function el(partial: Partial<ElementInfo> & { index: number }): ElementInfo {
  return { tag: "div", role: null, name: "", inViewport: true, ...partial };
}

describe("renderElements", () => {
  it("renders a button with name and role", () => {
    const out = renderElements([el({ index: 0, tag: "button", name: "Sign in", role: "button" })]);
    expect(out).toBe('[0] <button> "Sign in" role=button');
  });

  it("includes input type, value and placeholder", () => {
    const out = renderElements([
      el({ index: 3, tag: "input", type: "email", name: "", placeholder: "you@x.com", value: "" }),
    ]);
    expect(out).toContain("[3] <input type=email>");
    expect(out).toContain('placeholder="you@x.com"');
  });

  it("marks required and invalid form-field state", () => {
    const out = renderElements([
      el({ index: 0, tag: "input", type: "email", name: "Email", required: true, invalid: true }),
    ]);
    expect(out).toContain("[required]");
    expect(out).toContain("[invalid]");
  });

  it("marks checked, disabled and off-screen state", () => {
    const out = renderElements([
      el({ index: 1, tag: "input", type: "checkbox", checked: true, disabled: true, inViewport: false, name: "Agree" }),
    ]);
    expect(out).toContain("[checked]");
    expect(out).toContain("[disabled]");
    expect(out).toContain("(off-screen)");
  });

  it("truncates long values", () => {
    const out = renderElements([el({ index: 2, tag: "input", value: "x".repeat(80) })]);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(80);
  });

  it("renders one line per element", () => {
    const out = renderElements([el({ index: 0 }), el({ index: 1 }), el({ index: 2 })]);
    expect(out.split("\n")).toHaveLength(3);
  });

  it("numbers byte-identical descriptors so duplicates are distinguishable", () => {
    const dup = { tag: "button", name: "Add to cart", role: "button" } as const;
    const lines = renderElements([
      el({ index: 4, ...dup }),
      el({ index: 7, ...dup }),
      el({ index: 9, ...dup }),
    ]).split("\n");
    expect(lines[0]).toBe('[4] <button> "Add to cart" role=button (#1 of 3)');
    expect(lines[1]).toBe('[7] <button> "Add to cart" role=button (#2 of 3)');
    expect(lines[2]).toBe('[9] <button> "Add to cart" role=button (#3 of 3)');
  });

  it("does NOT number elements already distinguished by value, state or context", () => {
    const out = renderElements([
      el({ index: 0, tag: "input", type: "text", name: "Qty", value: "1" }),
      el({ index: 1, tag: "input", type: "text", name: "Qty", value: "2" }), // value differs
      el({ index: 2, tag: "button", name: "Revoke", role: "button", context: "prod" }),
      el({ index: 3, tag: "button", name: "Revoke", role: "button", context: "ci" }), // context differs
    ]);
    expect(out).not.toContain("of 2");
    expect(out).not.toContain("#1");
  });

  it("numbers only the colliding group, leaving unique lines untouched", () => {
    const out = renderElements([
      el({ index: 0, tag: "button", name: "Delete", role: "button" }),
      el({ index: 1, tag: "button", name: "Delete", role: "button" }),
      el({ index: 2, tag: "button", name: "Save", role: "button" }),
    ]).split("\n");
    expect(out[0]).toContain("(#1 of 2)");
    expect(out[1]).toContain("(#2 of 2)");
    expect(out[2]).toBe('[2] <button> "Save" role=button'); // unique -> no ordinal
  });
});
