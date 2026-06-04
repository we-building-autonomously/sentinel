/**
 * Collects runtime health signals from the page — uncaught JS exceptions,
 * console errors, and failed network responses — so the judge can factor real
 * defects into the verdict even when the UI looks fine. Pure and unit-testable:
 * the session feeds it primitive event data; it owns dedup, filtering, and caps.
 */

import type { Diagnostic } from "../types.js";
export type { Diagnostic };

/** URLs/patterns that are noise rather than app defects. */
const IGNORE_URL = /(favicon\.ico|\/__|hot-update|analytics|sentry|datadog|fullstory|hotjar)/i;
const IGNORE_TEXT = /(ResizeObserver loop|Download the React DevTools|\[vite\]|webpack-dev-server)/i;

export class DiagnosticsCollector {
  private byKey = new Map<string, Diagnostic>();
  private order: string[] = [];

  constructor(private cap = 50) {}

  private push(d: Omit<Diagnostic, "count">): void {
    const key = `${d.kind}|${d.status ?? ""}|${d.text}`;
    const existing = this.byKey.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    if (this.order.length >= this.cap) return;
    this.byKey.set(key, { ...d, count: 1 });
    this.order.push(key);
  }

  /** An uncaught exception thrown on the page. */
  pageError(message: string): void {
    const text = (message ?? "").split("\n")[0].trim().slice(0, 300);
    if (!text || IGNORE_TEXT.test(text)) return;
    this.push({ kind: "pageerror", level: "error", text });
  }

  /** A console message; only `error` is kept by default (warnings are noisy). */
  consoleMessage(type: string, text: string, url?: string): void {
    if (type !== "error") return;
    const t = (text ?? "").trim().slice(0, 300);
    if (!t || IGNORE_TEXT.test(t) || (url && IGNORE_URL.test(url))) return;
    this.push({ kind: "console", level: "error", text: t, url });
  }

  /** An HTTP response; 4xx/5xx are recorded as failures. */
  response(status: number, url: string, method = "GET"): void {
    if (status < 400) return;
    if (IGNORE_URL.test(url)) return;
    this.push({
      kind: "network",
      level: status >= 500 ? "error" : "warning",
      text: `${method} ${trimUrl(url)} → ${status}`,
      url,
      status,
    });
  }

  list(): Diagnostic[] {
    return this.order.map((k) => this.byKey.get(k)!);
  }

  get errorCount(): number {
    return this.list().filter((d) => d.level === "error").reduce((n, d) => n + d.count, 0);
  }

  /** A compact block for the judge prompt, or "" when the run was clean. */
  forJudge(): string {
    const items = this.list();
    if (!items.length) return "";
    return items
      .map((d) => `- [${d.level}/${d.kind}] ${d.text}${d.count > 1 ? ` (x${d.count})` : ""}`)
      .join("\n");
  }
}

function trimUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).slice(0, 120) || u.host;
  } catch {
    return url.slice(0, 120);
  }
}
