import type { RunReport, TestSpec } from "../types.js";
import { scrubSecrets } from "./secrets.js";

const MASK = "••••••";

/**
 * Collect every secret VALUE configured in a spec — the strings that must never
 * be echoed back in a log, trace, or report: the login password and TOTP seed,
 * any custom `auth.extra` values, request headers (API auth), basic-auth
 * password, cookie values, and setup/teardown hook headers/bodies. Pure: it
 * reads the spec and returns the list, mutating nothing.
 *
 * Shared by `redactReport` (artifacts) and the live runner (stdout/stream) so a
 * password typed during the run is masked at the moment it would be printed —
 * not only later, when the report is written.
 */
export function collectSpecSecrets(spec: TestSpec): string[] {
  const secrets: string[] = [];
  const auth = spec.app.auth;
  if (auth) {
    if (auth.password) secrets.push(auth.password);
    if (auth.totpSecret) secrets.push(auth.totpSecret);
    for (const v of Object.values(auth.extra ?? {})) if (v) secrets.push(v);
  }
  const app = spec.app;
  for (const v of Object.values(app.headers ?? {})) if (v) secrets.push(v);
  if (app.httpCredentials?.password) secrets.push(app.httpCredentials.password);
  for (const ck of app.cookies ?? []) if (ck.value) secrets.push(ck.value);
  for (const hook of [...(spec.setup ?? []), ...(spec.teardown ?? [])]) {
    for (const v of Object.values(hook.headers ?? {})) if (v) secrets.push(v);
    if (hook.body) secrets.push(hook.body);
  }
  return secrets;
}

/**
 * Build a scrubber that masks the given known secrets verbatim, then any
 * secret-SHAPED tokens the app may have revealed (a freshly created API key, a
 * token shown once) that the harness couldn't know in advance.
 */
export function makeScrubber(secrets: string[]): (s: string) => string {
  return (s: string) =>
    scrubSecrets(secrets.reduce((acc, sec) => (sec ? acc.split(sec).join(MASK) : acc), s));
}

/**
 * Return a deep clone of the report with secrets (password + auth.extra values)
 * masked everywhere they could appear — auth fields and any step text/inputs
 * that echoed them back. Used before any artifact (file or JSON stdout) leaves
 * the process. The caller's original object is never mutated.
 */
export function redactReport(report: RunReport): RunReport {
  const clone: RunReport = JSON.parse(JSON.stringify(report));
  const secrets = collectSpecSecrets(clone.spec);
  // Mask the secret-bearing spec fields in the echoed spec itself.
  const auth = clone.spec.app.auth;
  if (auth) {
    if (auth.password) auth.password = MASK;
    if (auth.totpSecret) auth.totpSecret = MASK;
    if (auth.extra) auth.extra = Object.fromEntries(Object.keys(auth.extra).map((k) => [k, MASK]));
  }
  const app = clone.spec.app;
  if (app.headers) app.headers = Object.fromEntries(Object.keys(app.headers).map((k) => [k, MASK]));
  if (app.httpCredentials?.password) app.httpCredentials.password = MASK;
  for (const ck of app.cookies ?? []) ck.value = MASK;
  for (const hook of [...(clone.spec.setup ?? []), ...(clone.spec.teardown ?? [])]) {
    if (hook.headers) hook.headers = Object.fromEntries(Object.keys(hook.headers).map((k) => [k, MASK]));
    if (hook.body) hook.body = MASK;
  }
  // Mask known spec credentials, then any secret-SHAPED tokens the app revealed
  // (a freshly created API key, a token shown once) so they never hit an artifact.
  const scrub = makeScrubber(secrets);
  for (const step of clone.steps) {
    step.result.summary = scrub(step.result.summary);
    if (typeof step.result.data === "string") step.result.data = scrub(step.result.data);
    if (step.thought) step.thought = scrub(step.thought);
    step.call.input = JSON.parse(scrub(JSON.stringify(step.call.input)));
  }
  for (const d of clone.dialogs ?? []) d.message = scrub(d.message);
  // A toast/status message can flash a secret (an OTP, a one-time token).
  if (clone.liveAnnouncements) clone.liveAnnouncements = clone.liveAnnouncements.map(scrub);
  // Network diagnostics embed real app URLs INCLUDING their query string, which
  // is a common place for tokens (?token=…, ?api_key=…); a download or an
  // asserted request URL can too. Scrub them all.
  for (const d of clone.diagnostics ?? []) {
    d.text = scrub(d.text);
    if (d.url) d.url = scrub(d.url);
  }
  for (const dl of clone.downloads ?? []) {
    dl.url = scrub(dl.url);
    dl.filename = scrub(dl.filename);
    if (dl.error) dl.error = scrub(dl.error);
  }
  for (const c of clone.requestChecks ?? []) {
    c.url = scrub(c.url);
    if (c.bodyIncludes) c.bodyIncludes = scrub(c.bodyIncludes);
  }
  // Hook URLs commonly carry tokens in the query string; the error too. Scrub
  // both the result rows AND the echoed spec.setup/teardown requests.
  for (const h of [...(clone.hooks?.setup ?? []), ...(clone.hooks?.teardown ?? [])]) {
    h.url = scrub(h.url);
    if (h.error) h.error = scrub(h.error);
  }
  for (const h of [...(clone.spec.setup ?? []), ...(clone.spec.teardown ?? [])]) h.url = scrub(h.url);
  // Author-declared assertion VALUES can be the secret itself: "the export
  // contains <token>", "the page must not show <token>", "the Copy button
  // copies <api-key>". Scrub the asserted strings too.
  for (const c of clone.textChecks ?? []) c.text = scrub(c.text);
  for (const c of clone.urlChecks ?? []) c.text = scrub(c.text);
  for (const c of clone.stateChecks ?? []) if (c.value) c.value = scrub(c.value);
  for (const c of clone.downloadChecks ?? []) {
    if (c.filename) c.filename = scrub(c.filename);
    if (c.contentIncludes) c.contentIncludes = scrub(c.contentIncludes);
  }
  if (clone.clipboardCheck) clone.clipboardCheck.expected = scrub(clone.clipboardCheck.expected);
  if (clone.toastCheck) clone.toastCheck.expected = scrub(clone.toastCheck.expected);
  // The verdict text could quote a secret the judge saw on the page.
  clone.verdict.summary = scrub(clone.verdict.summary);
  clone.verdict.issues = clone.verdict.issues.map(scrub);
  for (const c of clone.verdict.checkpoints) if (c.evidence) c.evidence = scrub(c.evidence);
  // Triage reason is derived from the agent's done-notes / verdict, which may
  // echo an on-page secret.
  if (clone.triage) clone.triage.reason = scrub(clone.triage.reason);
  // The landing URL can carry a token in its query string; the title may quote one.
  if (clone.finalUrl) clone.finalUrl = scrub(clone.finalUrl);
  if (clone.finalTitle) clone.finalTitle = scrub(clone.finalTitle);
  return clone;
}
