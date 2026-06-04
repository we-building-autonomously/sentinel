import { describe, it, expect } from "vitest";
import { TOOL_DEFS, ToolExecutor } from "./tools.js";
import type { BrowserSession } from "./session.js";

describe("TOOL_DEFS", () => {
  const byName = new Map(TOOL_DEFS.map((t) => [t.name, t]));

  it("exposes the full interaction surface a user needs", () => {
    for (const name of [
      "navigate",
      "click",
      "type",
      "select",
      "hover",
      "go_back",
      "press",
      "scroll",
      "wait_for",
      "extract",
      "click_at",
      "type_text",
      "drag",
      "get_totp",
      "done",
    ]) {
      expect(byName.has(name), `missing tool: ${name}`).toBe(true);
    }
  });

  it("get_totp takes no arguments", () => {
    expect(byName.has("get_totp")).toBe(true);
    expect(byName.get("get_totp")!.input_schema.required ?? []).toHaveLength(0);
  });

  it("drag requires from and to indices", () => {
    expect(byName.get("drag")!.input_schema.required).toEqual(expect.arrayContaining(["from", "to"]));
  });

  it("wait_for supports an optional `gone` flag (wait for disappearance)", () => {
    const props = byName.get("wait_for")!.input_schema.properties as Record<string, unknown>;
    expect(props.gone).toBeDefined();
    expect(byName.get("wait_for")!.input_schema.required).toEqual(["text"]); // gone is optional
  });

  it("drop_file requires an index", () => {
    expect(byName.has("drop_file")).toBe(true);
    expect(byName.get("drop_file")!.input_schema.required).toEqual(["index"]);
  });

  it("set_network requires an offline boolean", () => {
    expect(byName.has("set_network")).toBe(true);
    expect(byName.get("set_network")!.input_schema.required).toEqual(["offline"]);
  });

  it("click exposes button / double / modifiers options (index still the only required field)", () => {
    const props = byName.get("click")!.input_schema.properties as Record<string, unknown>;
    expect(props.button).toBeDefined();
    expect(props.double).toBeDefined();
    expect(props.modifiers).toBeDefined();
    expect(byName.get("click")!.input_schema.required).toEqual(["index"]);
  });

  it("every tool has a non-trivial description and a valid object schema", () => {
    for (const t of TOOL_DEFS) {
      expect(t.description && t.description.length, t.name).toBeGreaterThan(15);
      expect(t.input_schema.type).toBe("object");
    }
  });

  it("element-addressed tools require an index; coordinate tools require x/y", () => {
    expect(byName.get("hover")!.input_schema.required).toContain("index");
    expect(byName.get("click")!.input_schema.required).toContain("index");
    expect(byName.get("click_at")!.input_schema.required).toEqual(expect.arrayContaining(["x", "y"]));
    expect(byName.get("go_back")!.input_schema.required ?? []).toHaveLength(0);
  });
});

describe("get_totp execution", () => {
  it("returns the current code when a secret is configured", async () => {
    const session = { currentTotp: () => "123456" } as unknown as BrowserSession;
    const res = await new ToolExecutor(session).execute("get_totp", {});
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("123456");
    expect(res.data).toBe("123456");
  });

  it("fails cleanly when no 2FA secret is configured", async () => {
    const session = { currentTotp: () => undefined } as unknown as BrowserSession;
    const res = await new ToolExecutor(session).execute("get_totp", {});
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/no 2fa\/totp secret/i);
  });
});
