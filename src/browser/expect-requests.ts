/**
 * Network-request expectations: let a spec assert that the app actually made
 * (or did not make) certain HTTP calls. This catches a whole class of bugs the
 * UI hides — an "optimistic" success toast with no request behind it, a save
 * button that posts nothing, a request that silently 500s — where the screen
 * looks right but nothing really happened.
 *
 * Pure and unit-testable: the session feeds a flat request log; this evaluates
 * the declared expectations against it. The verdict still belongs to the judge,
 * which weighs an unmet expectation against the intent.
 */

/** One observed HTTP response during the run. */
export interface RequestRecord {
  method: string;
  url: string;
  status: number;
  /** The request's post body (capped), when present — for body assertions. */
  body?: string;
}

/** A spec-declared expectation about requests the app should make. */
export interface RequestExpectation {
  /** Match the URL: a glob if it contains "*", otherwise a substring match. */
  url: string;
  /** Optional HTTP method (case-insensitive). */
  method?: string;
  /** Optional exact status the matching request must have returned. */
  status?: number;
  /** Optional substring the request's post body must contain (verify the payload). */
  bodyIncludes?: string;
  /** Minimum number of matching requests required (default 1). */
  min?: number;
}

export interface RequestCheckResult {
  expectation: RequestExpectation;
  /** How many requests matched. */
  observed: number;
  met: boolean;
  /** Human-readable one-liner for the report / judge. */
  detail: string;
}

/** Glob (only `*` is special) or substring match for a URL pattern. */
export function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) return url.includes(pattern);
  const rx = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return rx.test(url) || url.includes(pattern.replace(/\*/g, ""));
}

/** True if one observed request satisfies an expectation's url/method/status/body. */
export function requestMatches(rec: RequestRecord, exp: RequestExpectation): boolean {
  if (!urlMatches(rec.url, exp.url)) return false;
  if (exp.method && rec.method.toUpperCase() !== exp.method.toUpperCase()) return false;
  if (exp.status != null && rec.status !== exp.status) return false;
  if (exp.bodyIncludes && !(rec.body ?? "").includes(exp.bodyIncludes)) return false;
  return true;
}

function describe(exp: RequestExpectation): string {
  const parts = [exp.method ? exp.method.toUpperCase() : "any", exp.url];
  if (exp.status != null) parts.push(`→ ${exp.status}`);
  if (exp.bodyIncludes) parts.push(`body~"${exp.bodyIncludes}"`);
  if (exp.min === 0) parts.push("(must NOT occur)");
  else if (exp.min && exp.min > 1) parts.push(`(×${exp.min}+)`);
  return parts.join(" ");
}

/**
 * Evaluate every expectation against the observed request log. `min: 0` is an
 * ABSENCE assertion (met only when zero requests match — e.g. "cancel must not
 * save"); otherwise the expectation needs at least `min` (default 1) matches.
 */
export function evaluateRequestExpectations(
  log: RequestRecord[],
  expectations: RequestExpectation[]
): RequestCheckResult[] {
  return expectations.map((exp) => {
    const observed = log.filter((r) => requestMatches(r, exp)).length;
    const met = exp.min === 0 ? observed === 0 : observed >= (exp.min ?? 1);
    return {
      expectation: exp,
      observed,
      met,
      detail: `${met ? "met" : "UNMET"}: expected ${describe(exp)} — observed ${observed} matching request(s)`,
    };
  });
}
