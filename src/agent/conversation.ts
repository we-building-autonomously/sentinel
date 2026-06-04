import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";

/**
 * Validate a message array against the Anthropic Messages API's structural
 * rules. Catches the bugs that 400 the real API but slip past a scripted test:
 *  - the first message must be from the user, and roles must alternate
 *  - no empty content arrays
 *  - every assistant `tool_use` is answered by a `tool_result` (matching id)
 *    in the immediately following user message, and vice-versa
 * Returns a list of human-readable problems ([] = valid). Pure/testable.
 */
export function validateConversation(messages: MessageParam[]): string[] {
  const errors: string[] = [];
  if (!messages.length) return ["conversation is empty"];
  if (messages[0].role !== "user") errors.push("first message must be from the user");

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i > 0 && m.role === messages[i - 1].role) {
      errors.push(`messages ${i - 1} and ${i} are both '${m.role}' (roles must alternate)`);
    }
    if (Array.isArray(m.content) && m.content.length === 0) {
      errors.push(`message ${i} has empty content`);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const toolUses = m.content.filter((b): b is Extract<ContentBlockParam, { type: "tool_use" }> => b.type === "tool_use");
    if (!toolUses.length) continue;

    const next = messages[i + 1];
    const results =
      next && Array.isArray(next.content)
        ? next.content.filter((b): b is Extract<ContentBlockParam, { type: "tool_result" }> => b.type === "tool_result")
        : [];
    const resultIds = new Set(results.map((r) => r.tool_use_id));
    const useIds = new Set(toolUses.map((t) => t.id));

    for (const tu of toolUses) {
      if (!resultIds.has(tu.id)) errors.push(`tool_use '${tu.id}' (message ${i}) has no matching tool_result`);
    }
    for (const r of results) {
      if (!useIds.has(r.tool_use_id)) errors.push(`tool_result '${r.tool_use_id}' references no tool_use in message ${i}`);
    }
  }

  return errors;
}
