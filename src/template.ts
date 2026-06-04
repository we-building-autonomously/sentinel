/**
 * Lightweight `{{token}}` templating for specs, so data-creation tests stay
 * repeatable (a fresh email/uuid per run) and portable across environments
 * (`{{env.BASE_URL}}`). Values are resolved ONCE per run, so the same token
 * used in multiple fields renders to the same value.
 */

export interface TemplateContext {
  timestamp: string;
  uuid: string;
  randomString: string;
  randomEmail: string;
  env: Record<string, string | undefined>;
  /** Per-case variables (data-driven specs); take precedence over built-ins. */
  vars?: Record<string, string>;
}

function randString(rand: () => number, len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/** Build a context once per run. now/rand are injectable for deterministic tests. */
export function makeContext(opts: { now?: number; rand?: () => number; env?: Record<string, string | undefined> } = {}): TemplateContext {
  const now = opts.now ?? Date.now();
  const rand = opts.rand ?? Math.random;
  const r = randString(rand, 8);
  const hex = (n: number) => randString(rand, n).replace(/[g-z]/g, () => "0123456789abcdef"[Math.floor(rand() * 16)]);
  return {
    timestamp: String(now),
    uuid: `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`,
    randomString: r,
    randomEmail: `qa+${r}@example.com`,
    env: opts.env ?? process.env,
  };
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Replace `{{token}}` and `{{env.NAME}}` in a string. Unknown tokens are left intact. */
export function renderTemplate(input: string, ctx: TemplateContext): string {
  return input.replace(TOKEN, (whole, name: string) => {
    if (name.startsWith("env.")) {
      const v = ctx.env[name.slice(4)];
      return v ?? whole;
    }
    // Per-case vars win over the built-in fields (so an author can name freely).
    const v = ctx.vars?.[name] ?? (ctx as unknown as Record<string, unknown>)[name];
    return typeof v === "string" ? v : whole;
  });
}

/** Return a copy of `ctx` with extra per-case variables merged in. */
export function withVars(ctx: TemplateContext, vars: Record<string, string>): TemplateContext {
  return { ...ctx, vars: { ...ctx.vars, ...vars } };
}

/** Deep-render every string leaf in a value (objects/arrays recursed). */
export function applyTemplates<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") return renderTemplate(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => applyTemplates(v, ctx)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyTemplates(v, ctx);
    return out as T;
  }
  return value;
}
