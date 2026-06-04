export interface SpecFilter {
  /** Keep specs that carry at least one of these tags (OR). Empty = no tag filter. */
  tags?: string[];
  /** Keep specs whose title matches this (case-insensitive) substring/regex. */
  grep?: string;
}

interface FilterableSpec {
  title?: unknown;
  tags?: unknown;
}

function asTags(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

function titleMatches(title: string, grep: string): boolean {
  try {
    return new RegExp(grep, "i").test(title);
  } catch {
    // Not a valid regex — fall back to a plain case-insensitive substring.
    return title.toLowerCase().includes(grep.toLowerCase());
  }
}

/** Filter a list of (raw) specs by tags and/or a title pattern. */
export function filterSpecs<T extends FilterableSpec>(specs: T[], filter: SpecFilter = {}): T[] {
  const wantTags = (filter.tags ?? []).filter(Boolean);
  const grep = filter.grep?.trim();
  return specs.filter((s) => {
    if (wantTags.length) {
      const have = asTags(s.tags);
      if (!wantTags.some((t) => have.includes(t))) return false;
    }
    if (grep) {
      const title = typeof s.title === "string" ? s.title : "";
      if (!titleMatches(title, grep)) return false;
    }
    return true;
  });
}

/** A 1-based CI shard: run partition `index` of `total` (e.g. {index:2,total:4}). */
export interface Shard {
  index: number;
  total: number;
}

/**
 * Parse a "i/n" shard spec (1-based, as Playwright/Jest use). Returns null for
 * undefined/empty input, throws a friendly error on a malformed or out-of-range
 * value so the CLI can report it cleanly.
 */
export function parseShard(input: string | undefined): Shard | null {
  const raw = input?.trim();
  if (!raw) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  if (!m) throw new Error(`Invalid --shard "${input}" — expected "i/n" (e.g. 2/4).`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1) throw new Error(`Invalid --shard "${input}" — total must be ≥ 1.`);
  if (index < 1 || index > total) throw new Error(`Invalid --shard "${input}" — index must be between 1 and ${total}.`);
  return { index, total };
}

/**
 * Deterministically keep only the items belonging to `shard`. Round-robin by
 * position so every shard gets a balanced, stable slice regardless of order
 * (item j → shard (j % total) + 1). No shard → all items.
 */
export function shardItems<T>(items: T[], shard?: Shard | null): T[] {
  if (!shard) return items;
  return items.filter((_, j) => j % shard.total === shard.index - 1);
}
