/**
 * URL assertions: a spec can require that the final page URL CONTAINS certain
 * substrings (`expectUrl`) and that it does NOT contain others (`forbidUrl`).
 *
 * "Did the flow end where it should?" is one of the most common QA checks and
 * a redirect is objective truth the LLM judge shouldn't have to infer:
 *   - expectUrl: ["/dashboard"]  — login landed on the dashboard
 *   - forbidUrl: ["/login", "error="] — we left the login page; no error query
 *
 * Matching is case-SENSITIVE substring against the full final URL (origin +
 * path + query + hash), so "/orders/42" and "?status=paid" both work. Pure and
 * unit-testable.
 */
export interface UrlCheckResult {
  kind: "contains" | "excludes";
  text: string;
  /** Whether the substring was found in the final URL. */
  found: boolean;
  /** contains → met when found; excludes → met when NOT found. */
  met: boolean;
  detail: string;
}

export function evaluateUrlExpectations(
  finalUrl: string | undefined,
  opts: { expect?: string[]; forbid?: string[] }
): UrlCheckResult[] {
  const url = finalUrl ?? "";
  const contains = (needle: string) => {
    const n = needle.trim();
    return n.length > 0 && url.includes(n);
  };
  const out: UrlCheckResult[] = [];
  for (const text of opts.expect ?? []) {
    const found = contains(text);
    out.push({
      kind: "contains",
      text,
      found,
      met: found,
      detail: `${found ? "met" : "UNMET"}: expected URL to contain "${text}" — ${found ? "did" : "did NOT"}`,
    });
  }
  for (const text of opts.forbid ?? []) {
    const found = contains(text);
    out.push({
      kind: "excludes",
      text,
      found,
      met: !found,
      detail: `${!found ? "met" : "UNMET"}: URL must not contain "${text}" — ${found ? "PRESENT (should not be)" : "absent"}`,
    });
  }
  return out;
}
