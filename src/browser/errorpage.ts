/**
 * Detect when the page itself is rendering an error / crash state. This is
 * distinct from the network diagnostics: an SPA frequently renders an error
 * boundary, a framework crash, or a server error body with a 200 (or cached)
 * status — so the response-status path never sees it, yet the user is staring
 * at a broken page. Catching it is the most central thing a QA agent does:
 * notice that the app is broken right now.
 *
 * IMPORTANT: this is only a SIGNAL, never an auto-fail. Some tests legitimately
 * drive the app into an error (e.g. "submitting an empty form shows an error").
 * The judge weighs the signal against the intent, exactly as it does console /
 * network errors. Detection is conservative — strong, unambiguous error
 * phrasing only — to keep ordinary copy that merely mentions "error" from
 * tripping it.
 */
export type ErrorKind = "http-5xx" | "http-404" | "client-exception" | "generic-error";

export interface ErrorState {
  kind: ErrorKind;
  /** The matched phrase, for evidence in the verdict/report. */
  evidence: string;
}

interface Rule {
  kind: ErrorKind;
  pattern: RegExp;
}

// Ordered: a specific HTTP/framework signal wins over the generic one.
const RULES: Rule[] = [
  { kind: "http-5xx", pattern: /\binternal server error\b/i },
  { kind: "http-5xx", pattern: /\b50[0-9]\s*[-–—:]?\s*(?:internal|server|bad gateway|service|gateway)/i },
  { kind: "http-5xx", pattern: /\bbad gateway\b/i },
  { kind: "http-5xx", pattern: /\bservice (?:temporarily )?unavailable\b/i },
  { kind: "http-5xx", pattern: /\bgateway time-?out\b/i },
  { kind: "http-5xx", pattern: /is currently unable to handle this request/i },
  { kind: "http-404", pattern: /\bpage not found\b/i },
  { kind: "http-404", pattern: /\b404\b[\s\S]{0,40}\bnot found\b/i },
  { kind: "http-404", pattern: /the page you(?:'re| are)? looking for (?:does(?:n't| not)|can(?:'t|not) be) (?:exist|found)/i },
  { kind: "http-404", pattern: /this page (?:could|couldn'?t|can'?t) (?:not )?be found/i },
  { kind: "client-exception", pattern: /application error:\s*a client-side exception has occurred/i },
  { kind: "client-exception", pattern: /unexpected application error/i },
  { kind: "client-exception", pattern: /\b(?:un)?caught (?:type)?error\b/i },
  { kind: "generic-error", pattern: /we'?re sorry[,.!]?\s*(?:but )?something went wrong/i },
  { kind: "generic-error", pattern: /\bsomething went wrong\b/i },
  { kind: "generic-error", pattern: /this page isn'?t working/i },
  { kind: "generic-error", pattern: /an (?:unexpected )?error (?:has )?occurred/i },
];

/** Returns the first error-state signal found in the page text, or null. */
export function detectErrorState(text: string): ErrorState | null {
  if (!text) return null;
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (m) return { kind: rule.kind, evidence: m[0].replace(/\s+/g, " ").trim().slice(0, 120) };
  }
  return null;
}

/** The observation banner for a detected error page (empty string if none). */
export function errorNote(text: string): string {
  const e = detectErrorState(text);
  return e
    ? `⚠ ERROR PAGE (${e.kind}): the page shows "${e.evidence}". If the task was NOT meant to ` +
        `trigger an error, the app is broken — verify and call done("failure"). If reaching this ` +
        `error IS the expected outcome, continue.\n`
    : "";
}
