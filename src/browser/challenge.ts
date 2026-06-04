/**
 * Detect "external challenge" walls — interaction barriers a QA agent cannot
 * legitimately clear on its own: CAPTCHAs, two-factor/OTP codes sent out of
 * band, and email/SMS verification links. These are extremely common on real
 * sign-in and signup flows.
 *
 * Two reasons this matters for a production harness:
 *   1. Without a signal, the agent burns steps guessing OTP codes or clicking a
 *      CAPTCHA widget forever. Recognizing the wall lets it stop cleanly and
 *      report `blocked` with a precise reason.
 *   2. Triage: a run stalled at a CAPTCHA is "couldn't proceed", NOT "the app
 *      is broken". Surfacing the challenge keeps the verdict from misreading an
 *      external gate as a product defect.
 *
 * Detection is conservative and text-based. If real test credentials DO include
 * what's needed (e.g. an OTP seed in auth.extra), the note is advisory only —
 * the agent may still proceed; it just shouldn't *guess*.
 */
export type ChallengeKind = "captcha" | "2fa-otp" | "email-verification";

export interface Challenge {
  kind: ChallengeKind;
  /** Human-readable, model-facing explanation of the wall and what to do. */
  hint: string;
}

interface Rule {
  kind: ChallengeKind;
  patterns: RegExp[];
  hint: string;
}

const RULES: Rule[] = [
  {
    kind: "captcha",
    patterns: [
      /\brecaptcha\b/i,
      /\bhcaptcha\b/i,
      /\bcf[-\s]?turnstile\b/i,
      /\bcloudflare\b[\s\S]{0,40}\b(challenge|verify)\b/i,
      /i['’]?m not a robot/i,
      /verify (?:that )?you(?:'re| are) (?:human|not a robot)/i,
      /press(?:\s*&|\s+and)?\s*hold\b[\s\S]{0,30}\bhuman\b/i,
    ],
    hint:
      "A CAPTCHA / bot-check appears to be present. A QA agent cannot solve it. " +
      "If nothing in the test setup is meant to bypass it, call done(blocked) and say a CAPTCHA blocked the flow.",
  },
  {
    kind: "2fa-otp",
    patterns: [
      /\btwo[-\s]?factor\b/i,
      /\b2fa\b/i,
      /\bmulti[-\s]?factor\b/i,
      /\bauthenticator app\b/i,
      /\b(one[-\s]?time|verification|authentication|security|login)\s+code\b/i,
      /enter the (?:\d+[-\s]?digit\s+)?code (?:we )?sent/i,
      /we (?:sent|texted|emailed) (?:you )?a code/i,
    ],
    hint:
      "A two-factor / one-time-code (OTP) prompt appears to be present. Do NOT guess the code. " +
      "Use a code only if the test credentials explicitly provide one (e.g. auth.extra); otherwise call done(blocked) citing 2FA.",
  },
  {
    kind: "email-verification",
    patterns: [
      /verify your email/i,
      /check your (?:inbox|email)/i,
      /confirmation (?:link|email)\b/i,
      /we(?:'ve| have) sent (?:you )?(?:a|an) (?:verification|confirmation) (?:link|email)/i,
      /click the link (?:we sent|in (?:your|the) email)/i,
    ],
    hint:
      "An email/inbox verification step appears to be required (a link was sent out of band). " +
      "A browser-only agent can't open that inbox. If the test setup doesn't pre-verify the account, call done(blocked) citing email verification.",
  },
];

/**
 * Returns the first challenge detected in the visible page text, or null.
 * Ordered captcha → 2fa → email so the most blocking wall wins when several
 * keywords co-occur (e.g. a 2FA screen that also mentions "email").
 */
export function detectChallenge(text: string): Challenge | null {
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return { kind: rule.kind, hint: rule.hint };
    }
  }
  return null;
}

/** The observation banner for a detected challenge (empty string if none). */
export function challengeNote(text: string, opts: { hasTotp?: boolean } = {}): string {
  const c = detectChallenge(text);
  if (!c) return "";
  // When a TOTP secret is configured, a 2FA prompt is solvable — point the
  // agent at the tool instead of telling it to give up.
  if (c.kind === "2fa-otp" && opts.hasTotp) {
    return (
      "⚠ EXTERNAL CHALLENGE (2fa-otp): A two-factor code is required. " +
      "A 2FA secret IS configured for this app — call get_totp to get the current code, then type it. Do NOT call done(blocked).\n"
    );
  }
  return `⚠ EXTERNAL CHALLENGE (${c.kind}): ${c.hint}\n`;
}
