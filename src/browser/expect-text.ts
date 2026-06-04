/**
 * Text content assertions: a spec can require that certain text IS present on
 * the final page (`expectText`) and that certain text is NOT (`forbidText`).
 *
 * These are objective, deterministic checks that complement the LLM judge.
 * `forbidText` especially catches a whole class of bugs the judge can gloss
 * over: an unrendered template variable ("{{user.name}}"), a stringified
 * "undefined" / "NaN" / "[object Object]" leaking into the UI, or a raw error
 * string. `expectText` pins exact copy ("Order confirmed", "Total: $40.00").
 *
 * Matching is case-SENSITIVE substring (so forbidding "NaN" doesn't trip on
 * "banana") with whitespace normalized to single spaces (so "Total:  $40.00"
 * matches "Total: $40.00"). Pure and unit-testable.
 */
export interface TextCheckResult {
  kind: "present" | "absent";
  text: string;
  /** Whether the text was found on the page. */
  found: boolean;
  /** present → met when found; absent → met when NOT found. */
  met: boolean;
  detail: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ");

export function evaluateTextExpectations(
  pageText: string,
  opts: { expect?: string[]; forbid?: string[] }
): TextCheckResult[] {
  const haystack = norm(pageText);
  const contains = (needle: string) => {
    const n = norm(needle).trim();
    return n.length > 0 && haystack.includes(n);
  };
  const out: TextCheckResult[] = [];
  for (const text of opts.expect ?? []) {
    const found = contains(text);
    out.push({
      kind: "present",
      text,
      found,
      met: found,
      detail: `${found ? "met" : "UNMET"}: expected text "${text}" — ${found ? "found" : "NOT found"}`,
    });
  }
  for (const text of opts.forbid ?? []) {
    const found = contains(text);
    out.push({
      kind: "absent",
      text,
      found,
      met: !found,
      detail: `${!found ? "met" : "UNMET"}: forbidden text "${text}" — ${found ? "PRESENT (should not be)" : "absent"}`,
    });
  }
  return out;
}
