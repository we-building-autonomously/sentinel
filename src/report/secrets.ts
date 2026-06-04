/**
 * Mask secret-looking tokens that an app may *reveal* during a test — a freshly
 * generated API key, a session token, a private key. The harness can't know
 * these in advance (unlike spec credentials), so it scrubs them by shape before
 * anything persists to a report. Conservative: only high-confidence patterns,
 * to avoid mangling normal page text. Pure/testable.
 */

const MASK = "«redacted-secret»";

const PATTERNS: RegExp[] = [
  // PEM private/secret key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // JWTs (three dot-separated base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._\-]{20,}/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub / Slack style prefixed tokens.
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Generic provider key: short lowercase prefix (which may itself contain
  // underscores like "sk_live") + "_" + a long token. Matches sk_live_…, pk_…,
  // cwz_… (the Lettuce "cwz_<48 hex>" key), key_…, etc.
  /\b[a-z][a-z_]{1,10}_[A-Za-z0-9]{20,}\b/g,
  // Bare long hex strings (>=32) — typical of raw API keys / hashes.
  /\b[0-9a-fA-F]{32,}\b/g,
];

/** Replace any high-confidence secret tokens in a string with a mask. */
export function scrubSecrets(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out;
}

/** True if the string contains something that looks like a secret. */
export function containsSecret(input: string): boolean {
  return PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(input);
  });
}
