/** Shared small pure helpers. */

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Collapse whitespace and cap length for log/summary lines. */
export function trimLine(s: string, n = 60): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** First line of an error message, length-capped. */
export function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split("\n")[0].slice(0, 200);
}
