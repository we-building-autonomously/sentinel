import { describe, it, expect, vi } from "vitest";
import { makePlan, criteriaPlan } from "./planner.js";
import type { LlmClient } from "../llm/anthropic.js";
import type { TestSpec } from "../types.js";

function spec(overrides: Partial<TestSpec> = {}): TestSpec {
  return {
    title: "t",
    task: "Add a product to the cart",
    intent: "The cart reflects the added product",
    app: { url: "http://x" },
    ...overrides,
  };
}

describe("criteriaPlan (explicit acceptance criteria are a contract)", () => {
  it("returns null when no criteria are given", () => {
    expect(criteriaPlan(spec())).toBeNull();
    expect(criteriaPlan(spec({ criteria: [] }))).toBeNull();
  });

  it("maps criteria 1:1 to checkpoints, verbatim and in order", () => {
    const plan = criteriaPlan(spec({ criteria: ["Cart count shows 2", "Subtotal is $40.00"] }));
    expect(plan).not.toBeNull();
    expect(plan!.checkpoints).toEqual([
      { id: 1, description: "Cart count shows 2", status: "unknown" },
      { id: 2, description: "Subtotal is $40.00", status: "unknown" },
    ]);
    expect(plan!.goal).toBe("Add a product to the cart");
  });

  it("trims whitespace and drops blank criteria without renumbering gaps", () => {
    const plan = criteriaPlan(spec({ criteria: ["  A  ", "", "   ", "B"] }));
    expect(plan!.checkpoints.map((c) => c.description)).toEqual(["A", "B"]);
    expect(plan!.checkpoints.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("makePlan", () => {
  it("uses explicit criteria deterministically WITHOUT calling the LLM", async () => {
    const structured = vi.fn();
    const llm = { structured } as unknown as LlmClient;
    const plan = await makePlan(llm, spec({ criteria: ["Cart count shows 2"] }));
    expect(structured).not.toHaveBeenCalled(); // no planning call, no drift
    expect(plan.checkpoints).toEqual([{ id: 1, description: "Cart count shows 2", status: "unknown" }]);
  });

  it("falls back to LLM derivation when no criteria are provided", async () => {
    const structured = vi.fn().mockResolvedValue({
      goal: "Add to cart and verify",
      checkpoints: ["A confirmation toast appears", "The cart badge increments"],
    });
    const llm = { structured } as unknown as LlmClient;
    const plan = await makePlan(llm, spec());
    expect(structured).toHaveBeenCalledOnce();
    expect(plan.goal).toBe("Add to cart and verify");
    expect(plan.checkpoints).toHaveLength(2);
    expect(plan.checkpoints[1]).toEqual({ id: 2, description: "The cart badge increments", status: "unknown" });
  });
});
