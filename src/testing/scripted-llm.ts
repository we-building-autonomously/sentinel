import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { LlmTurn } from "../llm/anthropic.js";
import { validateConversation } from "../agent/conversation.js";

export interface ScriptedAction {
  name: string;
  input: Record<string, unknown>;
  /** Optional free-text "reasoning" emitted alongside the tool call. */
  thought?: string;
}

/**
 * A deterministic stand-in for {@link LlmClient} for integration tests: it
 * replays a fixed sequence of tool calls for the agent loop and returns canned
 * structured outputs (plan / verdict / extract) by tool name. No network, no key.
 *
 * Cast to `LlmClient` at the injection site (`as unknown as LlmClient`).
 */
export class ScriptedLlm {
  private i = 0;
  public turnCount = 0;

  constructor(
    // Each entry is one turn: a single action, or an array to emit several
    // tool calls in the same turn (to exercise one-action-per-turn handling).
    private actions: Array<ScriptedAction | ScriptedAction[]>,
    private structuredByTool: Record<string, unknown | ((opts: { toolName: string; prompt: unknown }) => unknown)>
  ) {}

  async turn(opts?: { messages?: MessageParam[] }): Promise<LlmTurn> {
    // Guard: the loop must hand us a structurally-valid Anthropic conversation,
    // or the real API would 400. Surfacing it here makes every loop test a
    // message-shape check.
    if (opts?.messages) {
      const errors = validateConversation(opts.messages);
      if (errors.length) throw new Error(`Invalid conversation built by the loop: ${errors.join("; ")}`);
    }
    this.turnCount++;
    const entry =
      this.actions[this.i] ?? ({ name: "done", input: { outcome: "blocked", notes: "script exhausted" } } as ScriptedAction);
    if (this.i < this.actions.length) this.i++;
    const batch = Array.isArray(entry) ? entry : [entry];

    const raw: ContentBlockParam[] = [];
    const toolUses: LlmTurn["toolUses"] = [];
    let text = "";
    batch.forEach((action, k) => {
      const id = `call_${this.turnCount}_${k}`;
      if (action.thought && !text) {
        text = action.thought;
        raw.push({ type: "text", text: action.thought });
      }
      raw.push({ type: "tool_use", id, name: action.name, input: action.input } as ContentBlockParam);
      toolUses.push({ id, name: action.name, input: action.input });
    });

    return { text, toolUses, raw, stopReason: "tool_use", usage: { input: 10, output: 5 } };
  }

  async structured<T>(opts: { toolName: string; prompt: unknown }): Promise<T> {
    const entry = this.structuredByTool[opts.toolName];
    if (entry === undefined) {
      throw new Error(`ScriptedLlm: no structured output configured for tool "${opts.toolName}"`);
    }
    const value = typeof entry === "function" ? (entry as (o: typeof opts) => unknown)(opts) : entry;
    return value as T;
  }
}
