import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { validateConversation } from "./conversation.js";

const user = (text: string): MessageParam => ({ role: "user", content: [{ type: "text", text }] });
const assistantTool = (id: string): MessageParam => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "click", input: {} }],
});
const toolResult = (id: string): MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "ok" }] }],
});

describe("validateConversation", () => {
  it("accepts a well-formed tool-use conversation", () => {
    expect(
      validateConversation([user("goal + observation"), assistantTool("t1"), toolResult("t1"), assistantTool("t2"), toolResult("t2")])
    ).toEqual([]);
  });

  it("flags an empty conversation", () => {
    expect(validateConversation([])).toEqual(["conversation is empty"]);
  });

  it("requires the first message to be the user", () => {
    expect(validateConversation([assistantTool("t1"), toolResult("t1")])[0]).toMatch(/first message must be from the user/);
  });

  it("flags two consecutive same-role messages", () => {
    const errs = validateConversation([user("a"), user("b")]);
    expect(errs.join()).toMatch(/roles must alternate/);
  });

  it("flags empty content", () => {
    const errs = validateConversation([{ role: "user", content: [] }]);
    expect(errs.join()).toMatch(/empty content/);
  });

  it("flags a tool_use with no matching tool_result", () => {
    const errs = validateConversation([user("a"), assistantTool("t1"), user("no result here")]);
    expect(errs.join()).toMatch(/tool_use 't1'.*no matching tool_result/);
  });

  it("flags a tool_result that references no tool_use", () => {
    const errs = validateConversation([user("a"), assistantTool("t1"), toolResult("WRONG-ID")]);
    expect(errs.join()).toMatch(/no matching tool_result|references no tool_use/);
  });
});
