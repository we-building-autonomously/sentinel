/**
 * Detect a failed login — the app rejected the submitted credentials. "Log in
 * first" is the precondition for most real tests, so a wrong/expired credential
 * in the spec is one of the most common ways a run goes sideways: the agent
 * keeps re-trying or misreads the error. This is distinct from a crash
 * (errorpage.ts) or an external gate (challenge.ts) — it's a normal validation
 * message, but a high-signal one.
 *
 * Like the other detectors it's only a SIGNAL: a test that verifies "a bad
 * login is rejected" WANTS this. The agent weighs it against the intent.
 * Conservative phrasing — credential-specific words only — so ordinary form
 * validation ("enter a valid email") doesn't trip it.
 */
const SIGNALS: RegExp[] = [
  /invalid (?:credentials|login|password|username)/i,
  /incorrect (?:password|credentials|username)/i,
  /(?:password|credentials) (?:is |are )?(?:incorrect|invalid)/i,
  /wrong (?:password|credentials|username)/i,
  /(?:login|sign[- ]?in|authentication) (?:failed|unsuccessful|was unsuccessful)/i,
  /could ?n'?t (?:sign|log) you in/i,
  /(?:these )?credentials do not match/i, // common framework default (Laravel etc.)
  /the password you entered is incorrect/i,
  /(?:email|username) (?:or|and) password (?:you entered )?(?:is|are|do(?:es)? not match|don'?t match|is incorrect|are incorrect)/i,
  /account (?:not found|does ?n'?t exist)/i,
];

/** True if the visible text indicates the login was rejected. */
export function detectAuthFailure(text: string): boolean {
  if (!text) return false;
  return SIGNALS.some((p) => p.test(text));
}

/** The observation banner for a detected login failure (empty string if none). */
export function authFailureNote(text: string): string {
  return detectAuthFailure(text)
    ? "⚠ LOGIN appears to have FAILED — the app rejected the credentials. If the test credentials should be valid, " +
        "this is likely a wrong/expired credential in the spec: stop and call done('blocked') noting the bad login. " +
        "If verifying that a bad login IS rejected is the intent, this is the expected outcome — continue.\n"
    : "";
}
