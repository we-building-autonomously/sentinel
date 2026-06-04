import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { Locator } from "playwright";
import type { BrowserSession } from "./session.js";
import type { LlmClient } from "../llm/anthropic.js";
import type { ToolResult } from "../types.js";
import { trimLine as trim, errMsg } from "../util.js";

/** Minimal extension→MIME map for synthesized file drops. */
function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
      svg: "image/svg+xml", pdf: "application/pdf", csv: "text/csv", txt: "text/plain",
      json: "application/json", zip: "application/zip",
    }[ext] ?? "application/octet-stream"
  );
}

/**
 * Tool definitions advertised to the model. Element targets are addressed by
 * the integer `index` from the most recent snapshot.
 */
export const TOOL_DEFS: Tool[] = [
  {
    name: "navigate",
    description: "Navigate the browser to an absolute URL.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL." } },
      required: ["url"],
    },
  },
  {
    name: "click",
    description:
      "Click an element by its snapshot index. Use for buttons, links, checkboxes, tabs, menu items. " +
      "Options: button:'right' opens a context menu; double:true double-clicks (edit-in-place); " +
      "modifiers like ['Control'] or ['Shift'] for multi-select.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Element index from the snapshot." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default left)." },
        double: { type: "boolean", description: "Double-click instead of single." },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
          description: "Modifier keys to hold while clicking.",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "type",
    description:
      "Type text into an input/textarea by index. Clears existing content first. Set submit=true to press Enter afterwards. For a range slider, pass the numeric value as text (e.g. \"75\").",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["index", "text"],
    },
  },
  {
    name: "select",
    description: "Choose an option in a <select> dropdown by index, by visible label or value.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer" },
        value: { type: "string", description: "Option label or value to select." },
      },
      required: ["index", "value"],
    },
  },
  {
    name: "drag",
    description:
      "Drag one element onto another by index (reorder a list, move a kanban card, drop a file onto a zone). 'from' is the element to pick up, 'to' is the drop target.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "integer", description: "Index of the element to drag." },
        to: { type: "integer", description: "Index of the drop target." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "drop_file",
    description:
      "Drop a file onto a drag-and-drop UPLOAD zone by index (for uploaders that don't expose a clickable file input). Uses the test's configured upload file. If the zone is clickable and opens a file dialog, just click it instead.",
    input_schema: {
      type: "object",
      properties: { index: { type: "integer", description: "Index of the drop zone." } },
      required: ["index"],
    },
  },
  {
    name: "press",
    description:
      "Press a keyboard key or chord on the focused element (e.g. 'Enter', 'Escape', 'Control+a', 'Tab').",
    input_schema: {
      type: "object",
      properties: { keys: { type: "string" } },
      required: ["keys"],
    },
  },
  {
    name: "click_at",
    description:
      "VISION MODE ONLY: click at pixel coordinates (x, y) in the viewport. Use this when a screenshot is attached and the element list is empty/sparse (canvas-based apps). Read the coordinates off the screenshot.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X pixel from the left edge of the viewport." },
        y: { type: "integer", description: "Y pixel from the top edge of the viewport." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description:
      "VISION MODE ONLY: type text into whatever is currently focused (e.g. after click_at focuses a field). Set submit=true to press Enter after.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["text"],
    },
  },
  {
    name: "scroll",
    description:
      "Scroll up or down by roughly one viewport to reveal off-screen elements. Pass an `index` to scroll WITHIN that element's scrollable container instead of the whole page (for a long modal, chat panel, or fixed-height list).",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        index: { type: "integer", description: "Optional: scroll the container holding this element." },
      },
      required: ["direction"],
    },
  },
  {
    name: "hover",
    description:
      "Move the pointer over an element by index, without clicking. Use to reveal hover menus / tooltips / dropdowns before clicking the item they expose.",
    input_schema: {
      type: "object",
      properties: { index: { type: "integer" } },
      required: ["index"],
    },
  },
  {
    name: "go_back",
    description: "Navigate back to the previous page in history (the browser Back button).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "wait_for",
    description:
      "Wait until text appears on the page — or, with gone=true, until it DISAPPEARS (e.g. a 'Saving…' spinner or loading overlay clears). Up to ~10s. Use after actions that trigger async updates.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        gone: { type: "boolean", description: "Wait for the text to disappear instead of appear." },
      },
      required: ["text"],
    },
  },
  {
    name: "set_network",
    description:
      "Take the browser offline (offline:true) or back online (offline:false) to test offline behavior — e.g. that the app shows an offline banner or handles a dropped connection. Remember to go back online before continuing the rest of the flow.",
    input_schema: {
      type: "object",
      properties: { offline: { type: "boolean", description: "true = go offline, false = go back online." } },
      required: ["offline"],
    },
  },
  {
    name: "get_totp",
    description:
      "Return the current 6-digit two-factor (TOTP) authentication code, when a 2FA secret has been configured for this app. Use this when a login flow asks for an authenticator/2FA code, then type the returned code. The code is time-based — fetch it immediately before typing it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "extract",
    description:
      "Read and return visible text matching a description, to verify state (e.g. 'the confirmation message', 'the account balance'). Does not change the page.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "done",
    description:
      "Call when the task is complete or definitively cannot be completed. Provide the outcome you observed; the final pass/fail judgement is made separately.",
    input_schema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["success", "failure", "blocked"],
          description:
            "success = task appears done; failure = app behaved wrong; blocked = couldn't proceed (e.g. login broken).",
        },
        notes: { type: "string", description: "What you observed that supports this outcome." },
      },
      required: ["outcome", "notes"],
    },
  },
];

export interface DoneSignal {
  outcome: "success" | "failure" | "blocked";
  notes: string;
}

/** Thrown when a snapshot index no longer maps to a live element. */
export class StaleRefError extends Error {
  constructor(index: number) {
    super(
      `Element [${index}] no longer exists — the page changed since the last snapshot. ` +
        `Re-read the current observation and pick an index from it.`
    );
    this.name = "StaleRefError";
  }
}

/** Executes one tool call against the live session. Returns a model-facing result. */
export class ToolExecutor {
  done: DoneSignal | null = null;

  /** `llm` enables `extract` to answer the query directly instead of dumping text. */
  constructor(
    private session: BrowserSession,
    private llm?: LlmClient
  ) {}

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case "navigate":
          return await this.navigate(String(input.url));
        case "click":
          return await this.click(Number(input.index), {
            button: input.button as "left" | "right" | "middle" | undefined,
            double: Boolean(input.double),
            modifiers: Array.isArray(input.modifiers) ? (input.modifiers as string[]) : undefined,
          });
        case "type":
          return await this.type(
            Number(input.index),
            String(input.text ?? ""),
            Boolean(input.submit)
          );
        case "select":
          return await this.select(Number(input.index), String(input.value ?? ""));
        case "drag":
          return await this.drag(Number(input.from), Number(input.to));
        case "drop_file":
          return await this.dropFile(Number(input.index));
        case "click_at":
          return await this.clickAt(Number(input.x), Number(input.y));
        case "type_text":
          return await this.typeText(String(input.text ?? ""), Boolean(input.submit));
        case "hover":
          return await this.hover(Number(input.index));
        case "go_back":
          return await this.goBack();
        case "press":
          return await this.press(String(input.keys));
        case "scroll":
          return await this.scroll(
            String(input.direction) === "up" ? "up" : "down",
            input.index != null ? Number(input.index) : undefined
          );
        case "wait_for":
          return await this.waitFor(String(input.text ?? ""), Boolean(input.gone));
        case "set_network":
          return await this.setNetwork(Boolean(input.offline));
        case "get_totp":
          return this.getTotp();
        case "extract":
          return await this.extract(String(input.query ?? ""));
        case "done":
          this.done = {
            outcome: (input.outcome as DoneSignal["outcome"]) ?? "blocked",
            notes: String(input.notes ?? ""),
          };
          return { ok: true, summary: `Marked done: ${this.done.outcome}` };
        default:
          return { ok: false, summary: `Unknown tool: ${name}` };
      }
    } catch (err) {
      return { ok: false, summary: `Error in ${name}: ${errMsg(err)}` };
    }
  }

  private async navigate(url: string): Promise<ToolResult> {
    await this.session.goto(url);
    return { ok: true, summary: `Navigated to ${this.session.url()}` };
  }

  /**
   * Resolve a snapshot index to a present locator. If the element is gone
   * (DOM changed since the snapshot), fail fast with guidance instead of a
   * long, opaque timeout — staleness is a signal for the model to re-observe.
   */
  private async resolve(index: number): Promise<Locator> {
    const loc = this.session.locator(index);
    if ((await loc.count()) === 0) {
      throw new StaleRefError(index);
    }
    return loc;
  }

  /** Viewport bbox of a locator, for highlighting in the trace (best-effort). */
  private async box(loc: Locator): Promise<ToolResult["target"]> {
    const b = await loc.boundingBox().catch(() => null);
    return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : undefined;
  }

  /**
   * Fast actionability pre-check. Without it, Playwright waits the full action
   * timeout (~10s) for a disabled or hidden element and then throws an opaque
   * timeout the model can't reason about. Instead we detect the blocking state
   * immediately and explain WHY, so the agent fixes the precondition (fill the
   * missing field, scroll, dismiss an overlay) rather than blindly retrying.
   * On any probe error we assume actionable and let the real action surface
   * staleness — this only ever fast-fails a *clearly* blocked element.
   */
  private async blocker(
    loc: Locator,
    index: number,
    label: string,
    need: "click" | "edit"
  ): Promise<ToolResult | null> {
    if (!(await loc.isVisible().catch(() => true))) {
      return {
        ok: false,
        summary: `[${index}] ${trim(label)} is not visible — it may be hidden behind an overlay/modal or need scrolling or a prior step first.`,
      };
    }
    if (need === "edit") {
      if (!(await loc.isEditable().catch(() => true))) {
        const dis = await loc.isDisabled().catch(() => false);
        return {
          ok: false,
          summary: `[${index}] ${trim(label)} can't be typed into — it is ${dis ? "disabled" : "read-only"}. A precondition is likely unmet (a prior field, a toggle, or an edit-mode switch). Resolve that, then re-observe.`,
        };
      }
    } else if (!(await loc.isEnabled().catch(() => true))) {
      return {
        ok: false,
        summary: `[${index}] ${trim(label)} is disabled — it can't be clicked yet. A precondition is probably unmet (e.g. a required field is empty, terms unchecked, or a prior step incomplete). Address that first, then re-observe.`,
      };
    }
    return null;
  }

  private async click(
    index: number,
    opts: { button?: "left" | "right" | "middle"; double?: boolean; modifiers?: string[] } = {}
  ): Promise<ToolResult> {
    const loc = await this.resolve(index);
    const label = (await loc.textContent().catch(() => "")) || `element ${index}`;
    const blocked = await this.blocker(loc, index, label, "click");
    if (blocked) return blocked;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const target = await this.box(loc);
    const button = opts.button === "right" || opts.button === "middle" ? opts.button : "left";
    const VALID_MODS = new Set(["Alt", "Control", "Meta", "Shift"]);
    const modifiers = (opts.modifiers ?? []).filter((m): m is "Alt" | "Control" | "Meta" | "Shift" =>
      VALID_MODS.has(m)
    );
    await loc.click({ timeout: 10_000, button, clickCount: opts.double ? 2 : 1, modifiers });
    await this.session.settle();
    const how = [
      modifiers.length ? `${modifiers.join("+")}+` : "",
      opts.double ? "Double-" : "",
      button === "right" ? "Right-" : button === "middle" ? "Middle-" : "",
    ].join("");
    return { ok: true, summary: `${how}Clicked [${index}] ${trim(label)}`, target };
  }

  private async type(index: number, text: string, submit: boolean): Promise<ToolResult> {
    const loc = await this.resolve(index);
    // Some inputs (range slider, color picker) can't be filled — Playwright's
    // fill() throws on them. Set the value directly and dispatch input/change so
    // frameworks react. The agent passes the raw value ("75", "#ff0000").
    const inputType = await loc
      .evaluate((el) => (el instanceof HTMLInputElement ? el.type : ""))
      .catch(() => "");
    const setByValue = inputType === "range" || inputType === "color";
    const blocked = await this.blocker(loc, index, `element ${index}`, setByValue ? "click" : "edit");
    if (blocked) return blocked;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const target = await this.box(loc);
    if (setByValue) {
      await loc.evaluate((el, v) => {
        const inp = el as HTMLInputElement;
        inp.value = String(v);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }, text);
      return { ok: true, summary: `Set ${inputType} input [${index}] to "${trim(text)}"`, target };
    }
    await loc.fill(text, { timeout: 10_000 });
    if (submit) {
      await loc.press("Enter");
      await this.session.settle();
    }
    return {
      ok: true,
      summary: `Typed "${trim(text)}" into [${index}]${submit ? " and submitted" : ""}`,
      target,
    };
  }

  private async select(index: number, value: string): Promise<ToolResult> {
    const loc = await this.resolve(index);
    const target = await this.box(loc);
    try {
      // Short timeout: a missing option otherwise makes selectOption retry for
      // the full action timeout. We want to fail fast and report the options.
      const result = await loc
        .selectOption({ label: value }, { timeout: 2000 })
        .catch(() => loc.selectOption(value, { timeout: 2000 }));
      return { ok: true, summary: `Selected "${value}" in [${index}] (${result.join(",")})`, target };
    } catch {
      // Don't bounce back a bare "option not found" — tell the model what it
      // CAN pick, or that this isn't a native <select> at all (a custom ARIA
      // combobox must be opened by clicking, then its item clicked).
      const opts = (await loc.locator("option").allTextContents().catch(() => []))
        .map((o) => o.trim())
        .filter(Boolean)
        .slice(0, 25);
      const hint = opts.length
        ? ` Available options: ${opts.map((o) => `"${o}"`).join(", ")}.`
        : " No <option> elements found — this is likely a custom (ARIA) dropdown, not a native <select>: click it to open, then click the desired item.";
      return { ok: false, summary: `Couldn't select "${value}" in [${index}].${hint}`, target };
    }
  }

  private async drag(from: number, to: number): Promise<ToolResult> {
    const src = await this.resolve(from);
    const dst = await this.resolve(to);
    const srcLabel = (await src.textContent().catch(() => "")) || `element ${from}`;
    const dstLabel = (await dst.textContent().catch(() => "")) || `element ${to}`;
    const blocked = await this.blocker(src, from, srcLabel, "click");
    if (blocked) return blocked;
    await src.scrollIntoViewIfNeeded().catch(() => {});
    const target = await this.box(src);
    // Playwright's dragTo drives the full sequence (hover, mousedown, stepped
    // move, mouseup) and dispatches HTML5 drag events, covering both native
    // DnD and mouse-based reordering.
    await src.dragTo(dst, { timeout: 10_000 });
    await this.session.settle();
    return { ok: true, summary: `Dragged [${from}] ${trim(srcLabel)} onto [${to}] ${trim(dstLabel)}`, target };
  }

  private async dropFile(index: number): Promise<ToolResult> {
    const loc = await this.resolve(index);
    const file = this.session.nextUploadFile();
    if (!file) return { ok: false, summary: "No upload file configured — set `uploads: [path]` in the spec to drop a file." };
    if (!fs.existsSync(file)) return { ok: false, summary: `Upload file not found: ${file}` };
    const buffer = fs.readFileSync(file);
    if (buffer.length > 5_000_000) return { ok: false, summary: `Upload file too large to drop (${buffer.length} bytes).` };
    const name = path.basename(file);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const target = await this.box(loc);
    // Synthesize a DataTransfer carrying the file and dispatch the HTML5 drop
    // sequence — this is how a drop zone (no clickable input) receives a file.
    const dataTransfer = await this.session.page.evaluateHandle(
      ({ data, name, type }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(data)], name, { type }));
        return dt;
      },
      { data: Array.from(buffer), name, type: mimeFor(name) }
    );
    for (const type of ["dragenter", "dragover", "drop"]) {
      await loc.dispatchEvent(type, { dataTransfer });
    }
    await dataTransfer.dispose();
    await this.session.settle();
    return { ok: true, summary: `Dropped file "${name}" onto [${index}]`, target };
  }

  private async clickAt(x: number, y: number): Promise<ToolResult> {
    await this.session.page.mouse.click(x, y);
    await this.session.settle();
    // A point target — a small box centered on the click for the trace overlay.
    return { ok: true, summary: `Clicked at (${x}, ${y})`, target: { x: x - 8, y: y - 8, w: 16, h: 16 } };
  }

  private async typeText(text: string, submit: boolean): Promise<ToolResult> {
    await this.session.page.keyboard.type(text);
    if (submit) {
      await this.session.page.keyboard.press("Enter");
      await this.session.settle();
    }
    return { ok: true, summary: `Typed "${trim(text)}"${submit ? " and submitted" : ""} (focused element)` };
  }

  private async hover(index: number): Promise<ToolResult> {
    const loc = await this.resolve(index);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const target = await this.box(loc);
    await loc.hover({ timeout: 10_000 });
    // Give hover-triggered menus a moment to render before the next snapshot.
    await this.session.page.waitForTimeout(250);
    return { ok: true, summary: `Hovered [${index}]`, target };
  }

  private async goBack(): Promise<ToolResult> {
    const resp = await this.session.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await this.session.settle();
    return resp
      ? { ok: true, summary: `Went back to ${this.session.url()}` }
      : { ok: false, summary: "Couldn't go back — no previous page in history." };
  }

  private async press(keys: string): Promise<ToolResult> {
    await this.session.page.keyboard.press(keys);
    await this.session.settle();
    return { ok: true, summary: `Pressed ${keys}` };
  }

  private async scroll(direction: "up" | "down", index?: number): Promise<ToolResult> {
    const sign = direction === "down" ? 1 : -1;
    // With an index, scroll the element's nearest scrollable ancestor directly
    // (deterministic — wheel-over-element is unreliable for inner containers).
    if (index != null && !Number.isNaN(index)) {
      const loc = this.session.locator(index);
      if ((await loc.count()) > 0) {
        const scrolled = await loc
          .evaluate((el, dir) => {
            let node: Element | null = el;
            while (node) {
              const oy = getComputedStyle(node).overflowY;
              if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 2) {
                node.scrollBy(0, dir * Math.max(120, node.clientHeight * 0.8));
                return true;
              }
              node = node.parentElement;
            }
            return false;
          }, sign)
          .catch(() => false);
        if (scrolled) {
          await this.session.page.waitForTimeout(300);
          return { ok: true, summary: `Scrolled ${direction} within [${index}]` };
        }
        // No inner scroll container — fall through to a page scroll.
      }
    }
    await this.session.page.mouse.wheel(0, sign * 700);
    await this.session.page.waitForTimeout(300);
    return { ok: true, summary: `Scrolled ${direction}` };
  }

  private async waitFor(text: string, gone = false): Promise<ToolResult> {
    const loc = this.session.page.getByText(text, { exact: false }).first();
    try {
      // "hidden" resolves when the element is detached OR not visible — so it
      // covers both a spinner that hides and one that's removed from the DOM.
      await loc.waitFor({ timeout: 10_000, state: gone ? "hidden" : "visible" });
      return { ok: true, summary: gone ? `"${trim(text)}" is gone` : `Text appeared: "${trim(text)}"` };
    } catch {
      return {
        ok: false,
        summary: gone
          ? `Timed out — "${trim(text)}" is still present after 10s`
          : `Timed out waiting for "${trim(text)}"`,
      };
    }
  }

  private async setNetwork(offline: boolean): Promise<ToolResult> {
    await this.session.setOffline(offline);
    // Let the app's online/offline handlers run, then settle.
    await this.session.page.waitForTimeout(200);
    return { ok: true, summary: offline ? "Browser is now OFFLINE" : "Browser is back ONLINE" };
  }

  private getTotp(): ToolResult {
    const code = this.session.currentTotp();
    if (!code) {
      return {
        ok: false,
        summary: "No 2FA/TOTP secret is configured for this app, so a code cannot be generated.",
      };
    }
    return { ok: true, summary: `Current 2FA code: ${code}`, data: code };
  }

  private async extract(query: string): Promise<ToolResult> {
    const snap = await this.session.snapshot();
    if (!this.llm) {
      // No reasoning model wired: hand back the visible page text to read.
      return { ok: true, summary: `Read page text for "${trim(query)}"`, data: snap.text };
    }
    // Answer the question directly from the visible text — cheaper context for
    // the agent than re-reading the whole page, and grounds the verdict.
    const ans = await this.llm.structured<{ found: boolean; answer: string }>({
      system:
        "You inspect the visible text of a web page and answer one specific question about what is shown. Answer ONLY from the provided text. If the answer is not present, set found=false and say what is shown instead.",
      prompt: `QUESTION: ${query}\n\nPAGE TEXT:\n${snap.text || "(empty)"}`,
      schema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          answer: { type: "string" },
        },
        required: ["found", "answer"],
      },
      toolName: "answer",
      maxTokens: 400,
    });
    return {
      ok: true,
      summary: `${ans.found ? "Observed" : "Not found"}: ${trim(ans.answer, 140)}`,
      data: ans.answer,
    };
  }
}

