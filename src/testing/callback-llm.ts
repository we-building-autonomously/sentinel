import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { LlmTurn } from "../llm/anthropic.js";

export interface Decision {
  tool: string;
  input: Record<string, unknown>;
  thought?: string;
}

/** Concatenated text of the most recent user message (the latest observation). */
export function latestObservation(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (const c of b.content) if (c.type === "text") parts.push(c.text);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return "";
}

/**
 * An {@link LlmClient}-shaped driver whose decisions come from a callback that
 * INSPECTS the live observation (the rendered element list), instead of a fixed
 * script. This makes the loop drivable by observation-aware logic — robust test
 * fakes, record/replay, or a human in the loop — with no API key.
 *
 * Cast to `LlmClient` at the injection site (`as unknown as LlmClient`).
 */
export class CallbackLlm {
  private turnIndex = 0;

  constructor(
    private decide: (observation: string, turnIndex: number) => Decision,
    private structuredByTool: Record<string, unknown | ((opts: { toolName: string; prompt: unknown }) => unknown)> = {}
  ) {}

  async turn(opts: { messages: MessageParam[] }): Promise<LlmTurn> {
    const obs = latestObservation(opts.messages);
    const d = this.decide(obs, this.turnIndex++);
    const id = `call_${this.turnIndex}`;
    const raw: ContentBlockParam[] = [];
    if (d.thought) raw.push({ type: "text", text: d.thought });
    raw.push({ type: "tool_use", id, name: d.tool, input: d.input } as ContentBlockParam);
    return {
      text: d.thought ?? "",
      toolUses: [{ id, name: d.tool, input: d.input }],
      raw,
      stopReason: "tool_use",
      usage: { input: 10, output: 5 },
    };
  }

  async structured<T>(opts: { toolName: string; prompt: unknown }): Promise<T> {
    const entry = this.structuredByTool[opts.toolName];
    if (entry === undefined) throw new Error(`CallbackLlm: no structured output for "${opts.toolName}"`);
    return (typeof entry === "function" ? (entry as (o: typeof opts) => unknown)(opts) : entry) as T;
  }
}

/** Helper: find the index of the first element in a rendered observation whose
 *  line matches a predicate (by name/tag text). Returns -1 if none. */
export function findElementIndex(observation: string, match: (line: string) => boolean): number {
  for (const line of observation.split("\n")) {
    const m = /^\[(\d+)\]/.exec(line.trim());
    if (m && match(line)) return Number(m[1]);
  }
  return -1;
}
