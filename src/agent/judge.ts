import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { LlmClient } from "../llm/anthropic.js";
import type { Plan, Step, TestSpec, Verdict, Checkpoint } from "../types.js";
import type { DoneSignal } from "../browser/tools.js";
import { JUDGE_SYSTEM } from "./prompts.js";
import { reconcileVerdict } from "./reconcile.js";

/** Visual-intent keywords — when the test is about how the page LOOKS, the
 * judge should see a screenshot, not just read text. */
const VISUAL_INTENT =
  /\b(looks?|looking|layout|appearance|aligned|alignment|renders?|rendered|colou?r|styl(?:e|ed|ing)|design|overlap(?:s|ping)?|truncat\w*|responsive|visual(?:ly)?|above the fold|broken image)\b/i;

/**
 * Decide whether to attach the final-page screenshot to the judge. True when
 * visual regression is enabled or the task/intent/criteria mention appearance —
 * text-only adjudication can't see layout, overlap, broken images, or color.
 */
export function shouldVisionJudge(spec: TestSpec): boolean {
  if (spec.visual) return true;
  return VISUAL_INTENT.test(`${spec.task} ${spec.intent} ${(spec.criteria ?? []).join(" ")}`);
}

const VERDICT_SCHEMA = {
  type: "object" as const,
  properties: {
    decision: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    confidence: { type: "number", description: "0..1 confidence in the decision." },
    summary: { type: "string", description: "One-paragraph QA-style summary." },
    checkpoints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          status: { type: "string", enum: ["met", "unmet", "unknown"] },
          evidence: { type: "string" },
        },
        required: ["id", "status", "evidence"],
      },
    },
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["decision", "confidence", "summary", "checkpoints", "issues"],
};

interface RawVerdict {
  decision: Verdict["decision"];
  confidence: number;
  summary: string;
  checkpoints: Array<{ id: number; status: Checkpoint["status"]; evidence: string }>;
  issues: string[];
}

function renderTrace(steps: Step[], startUrl?: string): string {
  if (!steps.length) return "(no actions were taken)";
  let prevUrl = startUrl;
  return steps
    .map((s) => {
      const input = JSON.stringify(s.call.input);
      const data =
        s.call.name === "extract" && s.result.data
          ? `\n      observed: ${String(s.result.data).replace(/\s+/g, " ").slice(0, 400)}`
          : "";
      // Surface navigation: when a step lands on a new URL, the model needs to
      // see it — reaching (or failing to reach) a URL is often the whole test.
      const nav = s.url && s.url !== prevUrl ? `\n      ↳ navigated to ${s.url}` : "";
      if (s.url) prevUrl = s.url;
      return `  #${s.index} ${s.call.name}(${input}) -> ${s.result.ok ? "ok" : "ERROR"}: ${s.result.summary}${nav}${data}`;
    })
    .join("\n");
}

export async function judge(opts: {
  llm: LlmClient;
  spec: TestSpec;
  plan: Plan;
  steps: Step[];
  done: DoneSignal | null;
  exhausted: boolean;
  finalPageText: string;
  /** The URL the page ended on (navigation evidence for url-based checkpoints). */
  finalUrl?: string;
  /** The document title of the final page (evidence for title/tab checkpoints). */
  finalTitle?: string;
  /** Console/network/runtime errors observed during the run, pre-rendered. */
  diagnostics?: string;
  /** JS dialogs that were auto-handled during the run. */
  dialogs?: Array<{ type: string; message: string; action: string }>;
  /** Files the app triggered downloads of (exports, generated reports). */
  downloads?: Array<{ filename: string; bytes?: number; error?: string }>;
  /** Declared network stubs and how many requests each served. */
  mockActivity?: Array<{ description: string; hits: number }>;
  /** Results of declared network-request expectations, pre-rendered. */
  requestChecks?: string[];
  /** Results of declared text content assertions, pre-rendered. */
  textChecks?: string[];
  /** Results of declared URL assertions, pre-rendered. */
  urlChecks?: string[];
  /** Results of declared persisted-state assertions, pre-rendered. */
  stateChecks?: string[];
  /**
   * Labels of author-declared deterministic assertions that came back UNMET.
   * Used to reconcile a contradictory "pass" down to "fail" (objective truth
   * overrides the judge), independent of how the judge weighed them.
   */
  assertionFailures?: string[];
  /** Results of declared download assertions, pre-rendered. */
  downloadChecks?: string[];
  /** Result of a clipboard assertion, pre-rendered. */
  clipboardCheck?: string;
  /** Result of a toast/status assertion, pre-rendered. */
  toastCheck?: string;
  /** Transient ARIA live-region announcements (toasts/status) captured during the run. */
  liveAnnouncements?: string[];
  /** Accessibility audit summary line, if a11y was enabled. */
  a11y?: string;
  /** Security-header audit summary line, if security was enabled. */
  security?: string;
  /** Responsive-layout note, if the final page overflows horizontally. */
  layout?: string;
  /** The final page rendered an error/crash state (kind + matched evidence). */
  errorState?: { kind: string; evidence: string } | null;
  /** Performance-budget violations, if a budget was set and exceeded. */
  perfBudget?: string;
  /** Visual-regression note, if the page differs from its baseline. */
  visual?: string;
  /** Final-page screenshot to attach as visual evidence (base64). */
  screenshot?: { data: string; mediaType: "image/png" | "image/jpeg" } | null;
  model?: string;
}): Promise<Verdict> {
  const { spec, plan, steps, done, exhausted, finalPageText } = opts;

  const prompt = `TASK: ${spec.task}
INTENT (definition of success): ${spec.intent}

CHECKPOINTS:
${plan.checkpoints.map((c) => `  ${c.id}. ${c.description}`).join("\n")}

NAVIGATION: started at ${spec.app.url}${
    opts.finalUrl ? ` · ended at ${opts.finalUrl}` : ""
  }${opts.finalTitle ? ` · final page title "${opts.finalTitle}"` : ""} (treat the final URL and title as evidence for any checkpoint about reaching/leaving a page or what the tab shows).

AGENT ACTION TRACE:
${renderTrace(steps, spec.app.url)}

AGENT CLOSING ASSESSMENT: ${
    done ? `${done.outcome} — ${done.notes}` : exhausted ? "ran out of steps without concluding" : "none"
  }

CONSOLE / NETWORK ERRORS OBSERVED DURING THE RUN:
${opts.diagnostics?.trim() || "(none captured)"}

BROWSER DIALOGS AUTO-HANDLED DURING THE RUN (Sentinel accepts confirms/alerts automatically):
${
  opts.dialogs?.length
    ? opts.dialogs.map((d) => `- ${d.type} "${d.message}" → ${d.action}`).join("\n")
    : "(none)"
}
${
  opts.requestChecks?.length
    ? `\nNETWORK-REQUEST EXPECTATIONS (the author asserted these calls should/shouldn't happen). An UNMET expectation is strong evidence the action did not really take effect (e.g. an optimistic UI with no save behind it) — lean toward fail:\n${opts.requestChecks
        .map((c) => `- ${c}`)
        .join("\n")}`
    : ""
}${
  opts.textChecks?.length
    ? `\nTEXT ASSERTIONS (author-declared exact text that must be present / absent on the final page). An UNMET assertion is objective — a missing required string or a forbidden one (e.g. "undefined", an unrendered template var, an error string) present is a real defect; lean toward fail:\n${opts.textChecks
        .map((c) => `- ${c}`)
        .join("\n")}`
    : ""
}${
  opts.urlChecks?.length
    ? `\nURL ASSERTIONS (author-declared substrings the final page URL must / must not contain). An UNMET assertion is objective — the flow did not redirect where it should (e.g. still on /login, or an error= query is present); lean toward fail:\n${opts.urlChecks
        .map((c) => `- ${c}`)
        .join("\n")}`
    : ""
}${
  opts.stateChecks?.length
    ? `\nSTATE ASSERTIONS (author-declared cookies / local-/session-storage that must exist, hold a value, or be cleared after the run — storage you cannot see on the page). An UNMET assertion is objective: the app failed to persist (or clear) state — e.g. login stored no token, consent set no cookie, logout left the session; lean toward fail:\n${opts.stateChecks
        .map((c) => `- ${c}`)
        .join("\n")}`
    : ""
}${
  opts.downloadChecks?.length
    ? `\nDOWNLOAD ASSERTIONS (the author asserted an export file with a given name/content). An UNMET assertion means the expected export was missing or its content was wrong — lean toward fail:\n${opts.downloadChecks
        .map((c) => `- ${c}`)
        .join("\n")}`
    : ""
}${
  opts.liveAnnouncements?.length
    ? `\nTRANSIENT TOAST/STATUS MESSAGES announced during the run (captured even though they may have vanished — use them as evidence a success/error message appeared):\n${opts.liveAnnouncements
        .map((a) => `- "${a}"`)
        .join("\n")}`
    : ""
}${
  opts.toastCheck
    ? `\nTOAST/STATUS ASSERTION (the author asserted a confirmation/error message appears): ${opts.toastCheck}. An UNMET assertion means the expected message never appeared — lean toward fail.`
    : ""
}${
  opts.clipboardCheck
    ? `\nCLIPBOARD ASSERTION (the author asserted the app copies a value to the clipboard, e.g. a "Copy" button): ${opts.clipboardCheck}. An UNMET assertion means the copy didn't happen or copied the wrong value — lean toward fail if the task is about copying.`
    : ""
}${
  opts.downloads?.length
    ? `\nFILE DOWNLOADS the app triggered during the run (use as evidence when the task is about exporting/downloading a file):\n${opts.downloads
        .map((d) => `- "${d.filename}"${d.error ? ` — FAILED: ${d.error}` : d.bytes != null ? ` (${d.bytes} bytes${d.bytes === 0 ? " — empty file, likely a defect" : ""})` : ""}`)
        .join("\n")}`
    : ""
}${
  opts.mockActivity?.length
    ? `\nNETWORK STUBS (a stub with 0 hits means the app never requested it — the intended state may NOT have been exercised, so be cautious about a pass):\n${opts.mockActivity
        .map((m) => `- ${m.description} — ${m.hits} request(s)`)
        .join("\n")}`
    : ""
}${
  opts.errorState
    ? `\nFINAL PAGE ERROR STATE: the final page is rendering a ${opts.errorState.kind} error ("${opts.errorState.evidence}"). If the task/intent was NOT about reaching an error, this is a failure on the critical path — lean strongly toward "fail". If triggering this error WAS the intended outcome, it supports a pass.`
    : ""
}${
  opts.a11y
    ? `\nACCESSIBILITY AUDIT (axe-core) of the final page: ${opts.a11y}. List these as issues; only let them affect the verdict if the task/intent is about accessibility.`
    : ""
}${
  opts.security
    ? `\nSECURITY-HEADER AUDIT of the main document: ${opts.security}. List these as issues; only let them affect the verdict if the task/intent is about security.`
    : ""
}${
  opts.layout
    ? `\nRESPONSIVE LAYOUT: ${opts.layout} — a horizontal-scroll/overflow bug. List it as an issue; lean toward fail if the task/intent is about layout, responsiveness, or mobile.`
    : ""
}${
  opts.perfBudget
    ? `\nPERFORMANCE BUDGET EXCEEDED on initial load: ${opts.perfBudget}. The author set this budget as a requirement — treat exceeding it as a fail (or at least a prominent issue).`
    : ""
}${
  opts.visual
    ? `\nVISUAL REGRESSION vs baseline: ${opts.visual}. The page no longer looks like its approved baseline — flag this as an issue (and lean toward fail if the task is about appearance/layout).`
    : ""
}

FINAL VISIBLE PAGE TEXT:
${finalPageText.slice(0, 3000) || "(unavailable)"}
${
  opts.screenshot
    ? "\nA SCREENSHOT of the final page is attached below. Use it as visual evidence — judge any appearance/layout/visual checkpoint (alignment, overlap, broken images, color, truncation) from what you can actually SEE, not just the text."
    : ""
}
Render your verdict. Map each checkpoint id to met/unmet/unknown with evidence drawn from the trace.`;

  // When a screenshot is provided, send a multimodal prompt so the judge can
  // SEE the page — text-only adjudication is blind to visual defects.
  const promptContent: string | ContentBlockParam[] = opts.screenshot
    ? [
        { type: "text", text: prompt },
        { type: "image", source: { type: "base64", media_type: opts.screenshot.mediaType, data: opts.screenshot.data } },
      ]
    : prompt;

  const raw = await opts.llm.structured<RawVerdict>({
    system: JUDGE_SYSTEM,
    prompt: promptContent,
    schema: VERDICT_SCHEMA,
    toolName: "submit_verdict",
    model: opts.model,
    maxTokens: 1500,
  });

  // Merge the judge's per-checkpoint resolution back onto the plan checkpoints.
  const byId = new Map(raw.checkpoints.map((c) => [c.id, c]));
  const checkpoints: Checkpoint[] = plan.checkpoints.map((c) => {
    const r = byId.get(c.id);
    return {
      ...c,
      status: r?.status ?? "unknown",
      evidence: r?.evidence,
    };
  });

  // Enforce decision/checkpoint coherence: a "pass" that left a checkpoint
  // unmet (or unconfirmed) is downgraded so the harness never emits a green
  // that contradicts its own evidence.
  return reconcileVerdict(
    {
      decision: raw.decision,
      confidence: clamp01(raw.confidence),
      summary: raw.summary,
      checkpoints,
      issues: raw.issues ?? [],
    },
    { unmetAssertions: opts.assertionFailures }
  );
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
