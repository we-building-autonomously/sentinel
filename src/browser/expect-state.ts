/**
 * Persisted-state assertions: verify what the app stored in the browser after
 * the flow — cookies, localStorage, sessionStorage. These are objective checks
 * the LLM judge literally cannot see (storage isn't on the page) and that cover
 * a whole class of real QA needs:
 *   - { scope: "cookie", key: "cookie_consent", value: "accepted" }  — consent persisted
 *   - { scope: "localStorage", key: "auth_token" }                   — login stored a token
 *   - { scope: "localStorage", key: "theme", value: "dark" }         — preference persisted
 *   - { scope: "cookie", key: "session", absent: true }              — logout cleared the session
 *
 * `value` is a case-sensitive substring of the stored value. `absent: true`
 * flips the assertion: the key must NOT be present (value is ignored). Matching
 * is pure and unit-testable; reading the live browser state is done separately
 * (BrowserSession.stateSnapshot) so this stays deterministic.
 */
export type StateScope = "cookie" | "localStorage" | "sessionStorage";

export interface StateExpectation {
  scope: StateScope;
  key: string;
  /** Substring the stored value must contain (ignored when `absent`). */
  value?: string;
  /** Assert the key is NOT present (e.g. a cleared session cookie). */
  absent?: boolean;
}

export interface StateSnapshot {
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface StateCheckResult {
  scope: StateScope;
  key: string;
  value?: string;
  absent: boolean;
  /** Whether the key was present in the relevant store. */
  present: boolean;
  met: boolean;
  detail: string;
}

const STORE: Record<StateScope, keyof StateSnapshot> = {
  cookie: "cookies",
  localStorage: "localStorage",
  sessionStorage: "sessionStorage",
};

const label = (s: StateScope) => (s === "cookie" ? "cookie" : `${s} key`);

export function evaluateStateExpectations(
  snap: StateSnapshot,
  specs: StateExpectation[] | undefined
): StateCheckResult[] {
  const out: StateCheckResult[] = [];
  for (const spec of specs ?? []) {
    const store = snap[STORE[spec.scope]] ?? {};
    const present = Object.prototype.hasOwnProperty.call(store, spec.key);
    const absent = !!spec.absent;
    let met: boolean;
    let detail: string;
    if (absent) {
      met = !present;
      detail = `${met ? "met" : "UNMET"}: ${label(spec.scope)} "${spec.key}" must be absent — ${present ? "PRESENT (should not be)" : "absent"}`;
    } else if (spec.value != null && spec.value !== "") {
      const contains = present && store[spec.key].includes(spec.value);
      met = contains;
      detail = `${met ? "met" : "UNMET"}: ${label(spec.scope)} "${spec.key}" should contain "${spec.value}" — ${
        !present ? "key absent" : contains ? "matched" : "value did not match"
      }`;
    } else {
      met = present;
      detail = `${met ? "met" : "UNMET"}: ${label(spec.scope)} "${spec.key}" should be present — ${present ? "present" : "absent"}`;
    }
    out.push({ scope: spec.scope, key: spec.key, value: spec.value, absent, present, met, detail });
  }
  return out;
}
