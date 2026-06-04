import type { LlmClient } from "../llm/anthropic.js";
import type { TestSpec, Plan } from "../types.js";
import { PLANNER_SYSTEM, plannerUser } from "./prompts.js";

const PLAN_SCHEMA = {
  type: "object" as const,
  properties: {
    goal: { type: "string" },
    checkpoints: {
      type: "array",
      items: { type: "string" },
      description: "Ordered, observable success conditions.",
    },
  },
  required: ["goal", "checkpoints"],
};

interface RawPlan {
  goal: string;
  checkpoints: string[];
}

/**
 * Turn a list of checkpoint descriptions into a Plan, numbering them 1..N.
 */
function planFrom(goal: string, descriptions: string[]): Plan {
  return {
    goal,
    checkpoints: descriptions.map((description, i) => ({
      id: i + 1,
      description,
      status: "unknown" as const,
    })),
  };
}

/**
 * When the author supplied explicit acceptance criteria, those ARE the
 * checkpoints — verbatim, in order, one-to-one. They are a contract: the test
 * passes only if exactly those conditions hold, and they must be reported as
 * written, not reworded, merged, or dropped by a planning LLM. Returns null
 * when no explicit criteria were given (derive from intent instead).
 */
export function criteriaPlan(spec: TestSpec): Plan | null {
  const criteria = spec.criteria?.map((c) => c.trim()).filter(Boolean) ?? [];
  if (!criteria.length) return null;
  return planFrom(spec.task, criteria);
}

export async function makePlan(
  llm: LlmClient,
  spec: TestSpec,
  model?: string
): Promise<Plan> {
  // Explicit criteria are authoritative — honor them deterministically and skip
  // the planning call entirely (no LLM drift on the definition of success).
  const explicit = criteriaPlan(spec);
  if (explicit) return explicit;

  const raw = await llm.structured<RawPlan>({
    system: PLANNER_SYSTEM,
    prompt: plannerUser(spec),
    schema: PLAN_SCHEMA,
    toolName: "submit_plan",
    model,
  });
  return planFrom(raw.goal, raw.checkpoints);
}
