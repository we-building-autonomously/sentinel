import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { pruneObservations, OBS_MARKER, OBS_WINDOW } from "./loop.js";

function obsMsg(n: number): MessageParam {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: `t${n}`,
        content: [{ type: "text", text: `${OBS_MARKER}\nURL: /page/${n}\nelements...` }],
      },
    ],
  };
}

function countFullObservations(messages: MessageParam[]): number {
  let full = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        const t = b.content.find((x) => x.type === "text" && x.text.includes(OBS_MARKER));
        if (t) full++;
      }
    }
  }
  return full;
}

describe("pruneObservations", () => {
  it("keeps only the most recent OBS_WINDOW observations at full detail", () => {
    const messages = Array.from({ length: 6 }, (_, i) => obsMsg(i));
    pruneObservations(messages);
    expect(countFullObservations(messages)).toBe(OBS_WINDOW);
  });

  it("collapses the oldest observations, keeps the newest intact", () => {
    const messages = Array.from({ length: 5 }, (_, i) => obsMsg(i));
    pruneObservations(messages);
    const textOf = (m: MessageParam) => {
      const c = m.content;
      if (!Array.isArray(c)) return "";
      const tr = c[0];
      if (tr.type === "tool_result" && Array.isArray(tr.content)) {
        const t = tr.content[0];
        return t.type === "text" ? t.text : "";
      }
      return "";
    };
    // Newest (index 4) retained; oldest (index 0) collapsed.
    expect(textOf(messages[4])).toContain("/page/4");
    expect(textOf(messages[0])).toContain("omitted");
  });

  it("is a no-op when under the window", () => {
    const messages = [obsMsg(0), obsMsg(1)];
    pruneObservations(messages);
    expect(countFullObservations(messages)).toBe(2);
  });
});
