/**
 * Setup / teardown HTTP hooks — the harness fires these requests before (setup)
 * and after (teardown) the browser run, so a test can prepare and clean up its
 * own state instead of depending on whatever the app happened to be in. Dirty
 * shared state is the single biggest cause of flaky end-to-end tests:
 *   - setup:    [{ method: DELETE, url: "{{env.API}}/test/cart" }]   — start clean
 *   - setup:    [{ method: POST, url: ".../users", body: '{"email":"{{randomEmail}}"}' }]  — seed a fresh user
 *   - teardown: [{ method: DELETE, url: ".../users/{{uuid}}" }]      — clean up after
 *
 * Hooks are plain HTTP (independent of the browser session) so they target an
 * API directly; auth is via author-supplied `headers` (e.g. an API key). URLs
 * and bodies are already `{{template}}`-resolved by the runner, so per-case data
 * lines up with the data-driven `cases` it seeds.
 */

export interface HttpHook {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Required status; default = any 2xx. A mismatch marks the hook failed. */
  expectStatus?: number;
}

export interface HookResult {
  method: string;
  url: string;
  status?: number;
  ok: boolean;
  error?: string;
}

type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Fire one hook, returning a structured result (never throws). */
export async function runHook(
  hook: HttpHook,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<HookResult> {
  const method = hook.method ?? "GET";
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(hook.url, {
      method,
      headers: hook.headers,
      body: hook.body,
      signal: controller.signal,
    });
    const ok = hook.expectStatus != null ? res.status === hook.expectStatus : res.status >= 200 && res.status < 300;
    return {
      method,
      url: hook.url,
      status: res.status,
      ok,
      error: ok
        ? undefined
        : hook.expectStatus != null
          ? `expected status ${hook.expectStatus}, got ${res.status}`
          : `non-2xx status ${res.status}`,
    };
  } catch (err) {
    return { method, url: hook.url, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Fire hooks in order, stopping early once one fails when `stopOnError`. */
export async function runHooks(
  hooks: HttpHook[] | undefined,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; stopOnError?: boolean } = {}
): Promise<HookResult[]> {
  const results: HookResult[] = [];
  for (const hook of hooks ?? []) {
    const r = await runHook(hook, opts);
    results.push(r);
    if (!r.ok && opts.stopOnError) break;
  }
  return results;
}
