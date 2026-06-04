import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { LlmClient } from "../llm/anthropic.js";
import type { BrowserSession } from "../browser/session.js";
import { ToolExecutor, TOOL_DEFS, type DoneSignal } from "../browser/tools.js";
import { shouldUseVision, type PageSnapshot } from "../browser/indexer.js";
import type { Plan, Step, ToolResult } from "../types.js";
import { containsSecret } from "../report/secrets.js";
import { AGENT_SYSTEM, agentGoalBlock } from "./prompts.js";
import { LoopGuard } from "./guard.js";

export const OBS_MARKER = "=== PAGE OBSERVATION ===";
/** How many recent observations to keep at full detail in the context window. */
export const OBS_WINDOW = 3;

export interface AgentRunResult {
  steps: Step[];
  done: DoneSignal | null;
  /** True if we hit the step cap without the agent declaring done. */
  exhausted: boolean;
  finalText: string;
  usage: { input: number; output: number };
}

/**
 * Build the observation content blocks for a snapshot. When the DOM is too
 * sparse to drive (canvas apps), attach a screenshot and tell the model to use
 * the coordinate tools — this is the vision fallback.
 */
async function observationBlocks(
  session: BrowserSession,
  snap: PageSnapshot
): Promise<ContentBlockParam[]> {
  const blocks: ContentBlockParam[] = [{ type: "text", text: renderObservation(snap) }];
  if (shouldUseVision(snap)) {
    const shot = await session.screenshotBase64();
    blocks.push({
      type: "text",
      text:
        `VISION MODE: the DOM has few addressable elements (likely a canvas app). ` +
        `A screenshot of the ${shot.width}×${shot.height} viewport is attached. ` +
        `Interact using click_at(x, y) and type_text — read coordinates off the screenshot.`,
    });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: shot.mediaType, data: shot.data },
    });
  }
  return blocks;
}

/** True if a message carries an image content block. */
function hasImage(msg: MessageParam): boolean {
  return Array.isArray(msg.content) && msg.content.some((b) => b.type === "image");
}

/** Keep only the most recent screenshot in context; drop older ones (cost). */
function stripImagesExceptLast(messages: MessageParam[]): void {
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasImage(messages[i])) {
      lastIdx = i;
      break;
    }
  }
  for (let i = 0; i < messages.length; i++) {
    if (i === lastIdx || !Array.isArray(messages[i].content)) continue;
    messages[i].content = (messages[i].content as ContentBlockParam[]).filter(
      (b) => b.type !== "image"
    );
  }
}

function renderObservation(snap: PageSnapshot): string {
  return [
    OBS_MARKER,
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    "",
    "Interactable elements:",
    snap.elements.length ? snap.rendered : "(none detected)",
    "",
    "Visible text:",
    snap.text || "(empty)",
  ].join("\n");
}

/** A signature of what the model would perceive: url + title + element listing. */
export function obsSig(snap: PageSnapshot): string {
  return `${snap.url}\n${snap.title}\n${snap.rendered}`;
}

/**
 * Decide whether the new observation is identical to the previous one and can be
 * collapsed to a short note (saving tokens). Vision-mode observations are never
 * collapsed — the screenshot IS the perception and the page may have changed
 * visually without changing the DOM listing.
 */
export function observationUnchanged(prevSig: string | null, snap: PageSnapshot): boolean {
  if (prevSig == null) return false;
  if (shouldUseVision(snap)) return false;
  return obsSig(snap) === prevSig;
}

/** Strip detailed observations from all but the most recent OBS_WINDOW messages. */
export function pruneObservations(messages: MessageParam[]): void {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const text = obsTextOf(block);
      if (text == null) continue;
      seen++;
      if (seen > OBS_WINDOW) {
        const collapsed = "[earlier page snapshot omitted to save context]";
        setObsText(block, collapsed);
      }
    }
  }
}

function obsTextOf(block: ContentBlockParam): string | null {
  if (block.type === "text" && block.text.startsWith(OBS_MARKER)) return block.text;
  if (block.type === "tool_result") {
    const c = block.content;
    if (Array.isArray(c)) {
      const t = c.find((b) => b.type === "text" && b.text.includes(OBS_MARKER));
      return t && t.type === "text" ? t.text : null;
    }
  }
  return null;
}

function setObsText(block: ContentBlockParam, value: string): void {
  if (block.type === "text") {
    block.text = value;
  } else if (block.type === "tool_result" && Array.isArray(block.content)) {
    for (const b of block.content) {
      if (b.type === "text" && b.text.includes(OBS_MARKER)) b.text = value;
    }
  }
}

/**
 * Drive the browser to attempt the task. Returns the recorded trace and the
 * agent's closing signal. The pass/fail judgement happens later in the judge.
 */
export async function runAgent(opts: {
  llm: LlmClient;
  session: BrowserSession;
  plan: Plan;
  maxSteps: number;
  /** App context (url, notes, credentials) injected into the agent's seed turn. */
  context?: string;
  /** Wall-clock budget for the whole run, in ms (0/undefined = none). */
  maxDurationMs?: number;
  /** Injectable clock for determinism in tests. */
  now?: () => number;
  onStep?: (step: Step) => void;
}): Promise<AgentRunResult> {
  const { llm, session, plan, maxSteps } = opts;
  const executor = new ToolExecutor(session, llm);
  const steps: Step[] = [];
  const usage = { input: 0, output: 0 };
  const now = opts.now ?? (() => Date.now());
  const guard = new LoopGuard({ startedAt: now(), maxDurationMs: opts.maxDurationMs });
  let stoppedBy: string | null = null;
  /** Consecutive turns where the model spoke but called no tool. */
  let noActionStreak = 0;
  /** Give up after this many no-action turns in a row (avoid burning the budget). */
  const MAX_NO_ACTION = 3;

  // Seed the conversation with the goal and the first observation.
  const firstSnap = await session.snapshot();
  let lastSnap = firstSnap;
  const seed: ContentBlockParam[] = [{ type: "text", text: agentGoalBlock(plan) }];
  if (opts.context) seed.push({ type: "text", text: opts.context });
  seed.push(...(await observationBlocks(session, firstSnap)));
  const messages: MessageParam[] = [{ role: "user", content: seed }];
  // Track the last full observation so identical follow-ups can be collapsed.
  let prevObsSig: string | null = shouldUseVision(firstSnap) ? null : obsSig(firstSnap);

  let finalText = "";

  for (let i = 0; i < maxSteps; i++) {
    // Cheap pre-call check so we don't pay for an LLM call past the budget.
    const timeStop = guard.timeExceeded(now());
    if (timeStop.stop) {
      stoppedBy = timeStop.message;
      break;
    }

    // The LlmClient already retries transient API errors with backoff; if a
    // call still throws here the API is sustained-down (or the request was
    // rejected). Don't crash the whole run with no report — stop gracefully as
    // "blocked" so the judge/report/triage path still produces a result.
    let turn: Awaited<ReturnType<typeof llm.turn>>;
    try {
      turn = await llm.turn({
        system: AGENT_SYSTEM,
        tools: TOOL_DEFS,
        messages,
        maxTokens: 1024,
      });
    } catch (err) {
      stoppedBy = `Model API call failed after retries: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      break;
    }
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    finalText = turn.text || finalText;

    messages.push({ role: "assistant", content: turn.raw });

    if (turn.toolUses.length === 0) {
      // Model spoke but didn't act. Nudge it once; if it keeps refusing to act,
      // stop instead of burning the whole step budget on inert turns.
      if (++noActionStreak >= MAX_NO_ACTION) {
        stoppedBy = `The model produced ${MAX_NO_ACTION} turns in a row without taking any action — halting.`;
        break;
      }
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "You did not call a tool. Take exactly one concrete action now, or call done.",
          },
        ],
      });
      continue;
    }
    noActionStreak = 0; // the model acted — reset the inert-turn counter

    // Loop/stuck guard: register the chosen action against the current page
    // signature. `done` is exempt — it legitimately ends the run.
    const lead = turn.toolUses[0];
    if (lead.name !== "done") {
      const actionSig = `${lead.name}:${JSON.stringify(lead.input)}`;
      // Use the rendered element list (content), not just url+count — an SPA
      // keeps the same URL and can coincidentally have a stable element count
      // across very different views, which would false-trip no-progress.
      const pageSig = obsSig(lastSnap);
      const verdict = guard.register(now(), actionSig, pageSig);
      if (verdict.stop) {
        stoppedBy = verdict.message;
        break;
      }
    }

    // Honor exactly ONE action per turn. Element indices come from a single
    // snapshot; executing a second action would address a now-stale DOM. We
    // still must return a tool_result for every tool_use the model emitted, so
    // extras are answered with a skip note telling it to re-observe.
    const resultBlocks: ContentBlockParam[] = [];
    let executed: { result: ToolResult; screenshotName: string } | null = null;
    for (let t = 0; t < turn.toolUses.length; t++) {
      const tu = turn.toolUses[t];
      if (t > 0) {
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          is_error: true,
          content: [
            {
              type: "text",
              text: "Skipped: one action per step. Re-read the updated observation before this action — indices may have changed.",
            },
          ],
        });
        continue;
      }

      const t0 = now();
      const urlBefore = session.url();
      const result = await executor.execute(tu.name, tu.input);
      const durationMs = now() - t0;
      const screenshot = await session.screenshot(tu.name);
      if (screenshot) {
        result.screenshot = screenshot;
        executed = { result, screenshotName: screenshot };
      }
      // The post-action screenshot is on a new page if navigation happened —
      // the pre-action target box would be misplaced, so drop it.
      if (result.target && session.url() !== urlBefore) result.target = undefined;

      const step: Step = {
        index: steps.length,
        thought: turn.text || undefined,
        call: { name: tu.name, input: tu.input },
        result,
        url: session.url(),
        timestamp: new Date().toISOString(),
        durationMs,
      };
      steps.push(step);
      opts.onStep?.(step);

      let content = result.summary;
      if (result.data && tu.name === "extract") {
        content += `\n\n--- extracted text ---\n${String(result.data).slice(0, 2500)}`;
      }
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        is_error: !result.ok,
        content: [{ type: "text", text: content }],
      });
    }

    if (executor.done) {
      return {
        steps,
        done: executor.done,
        exhausted: false,
        finalText,
        usage,
      };
    }

    // A click may have opened a new tab or popped a JS dialog — reconcile both
    // before observing so the model sees the real current state.
    const tabNote = session.syncActivePage();
    const dialogs = session.drainDialogs();
    const downloads = session.drainDownloads();
    const notes = [...dialogs, ...downloads, ...(tabNote ? [tabNote] : [])];
    if (notes.length) {
      resultBlocks.push({
        type: "text",
        text: "EVENTS: " + notes.join("; ") + ".",
      });
    }

    // Append a fresh observation so the model sees the consequence of its action.
    // If the page is byte-for-byte identical to the last one, collapse it to a
    // short note (the prior full observation + its indices are still valid).
    const snap = await session.snapshot();
    lastSnap = snap;

    // If the resulting page is displaying a secret (a freshly-minted API key,
    // a token shown once), the screenshot would persist it as an image that
    // text redaction can't reach — suppress it.
    if (executed && containsSecret(snap.text)) {
      session.removeArtifact(executed.screenshotName);
      executed.result.screenshot = undefined;
      executed.result.summary += " [screenshot withheld — page displayed a secret]";
    }
    if (observationUnchanged(prevObsSig, snap)) {
      resultBlocks.push({
        type: "text",
        text: "PAGE UNCHANGED since the last observation — the element indices above are still valid.",
      });
    } else {
      resultBlocks.push(...(await observationBlocks(session, snap)));
      prevObsSig = shouldUseVision(snap) ? null : obsSig(snap);
    }
    messages.push({ role: "user", content: resultBlocks });

    pruneObservations(messages);
    stripImagesExceptLast(messages);
  }

  if (stoppedBy) {
    // Halted by a guardrail — present it to the judge as a blocked outcome.
    return {
      steps,
      done: { outcome: "blocked", notes: stoppedBy },
      exhausted: false,
      finalText,
      usage,
    };
  }

  return { steps, done: null, exhausted: true, finalText, usage };
}
