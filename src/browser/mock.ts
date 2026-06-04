/**
 * Network stubs let a spec test states that are hard to trigger for real — an
 * API 500, an empty list, a slow/loading response. Each mock matches a URL glob
 * (and optionally a method) and fulfills the request with a canned response.
 */
export interface NetworkMock {
  /** URL glob, e.g. "**\/api/items" or "**\/checkout". */
  url: string;
  /** Restrict to a single HTTP method (GET/POST/...). Omit to match all. */
  method?: string;
  /** Response status (default 200). */
  status?: number;
  /** JSON body — sets content-type application/json automatically. */
  json?: unknown;
  /** Raw body (used when `json` is absent). */
  body?: string;
  /** Content-type for a raw body (default text/plain). */
  contentType?: string;
  /** Delay before responding, in ms — simulate slow networks / loading states. */
  delayMs?: number;
}

/** Playwright `route.fulfill` options for a mock (pure; method/delay handled by the caller). */
export function fulfillmentFor(mock: NetworkMock): Record<string, unknown> {
  const status = mock.status ?? 200;
  if (mock.json !== undefined) {
    return { status, json: mock.json };
  }
  return { status, body: mock.body ?? "", contentType: mock.contentType ?? "text/plain" };
}

/** True if a request method matches the mock's method filter (case-insensitive). */
export function methodMatches(mock: NetworkMock, method: string): boolean {
  if (!mock.method) return true;
  return mock.method.toLowerCase() === method.toLowerCase();
}

/** A one-line description of a mock, for the agent context + report. */
export function describeMock(mock: NetworkMock): string {
  const m = mock.method ? `${mock.method.toUpperCase()} ` : "";
  const what = mock.json !== undefined ? "JSON" : mock.body ? "body" : "empty";
  const delay = mock.delayMs ? ` after ${mock.delayMs}ms` : "";
  return `${m}${mock.url} → HTTP ${mock.status ?? 200} (${what})${delay}`;
}
