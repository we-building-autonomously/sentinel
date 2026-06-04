import { z } from "zod";
import { TestSpecSchema, AppMetaSchema } from "./types.js";
import { SuiteSchema, applyDefaults, type Suite } from "./suite.js";
import { applyTemplates, makeContext, type TemplateContext } from "./template.js";

export interface ValidationResult {
  kind: "spec" | "suite";
  ok: boolean;
  errors: string[];
  /** Non-fatal: unknown keys that zod silently strips (likely typos). */
  warnings: string[];
}

function formatIssues(prefix: string, err: z.ZodError): string[] {
  return err.issues.map((i) => `${prefix}${i.path.join(".") || "(root)"}: ${i.message}`);
}

const SPEC_KEYS = new Set(Object.keys(TestSpecSchema.shape));
const APP_KEYS = new Set(Object.keys(AppMetaSchema.shape));
const SUITE_KEYS = new Set(Object.keys(SuiteSchema.shape));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * zod strips unknown keys silently, so a typo (`forbidTex`, `expectRequest`)
 * passes validation yet does nothing at runtime. Surface those as warnings so
 * the author notices the field is being ignored.
 */
function unknownKeyWarnings(obj: Record<string, unknown>, known: Set<string>, label: string): string[] {
  return Object.keys(obj)
    .filter((k) => !known.has(k))
    .map((k) => `${label}unknown field "${k}" — ignored at runtime (typo?)`);
}

function specWarnings(spec: Record<string, unknown>, label: string): string[] {
  const w = unknownKeyWarnings(spec, SPEC_KEYS, label);
  if (isPlainObject(spec.app)) w.push(...unknownKeyWarnings(spec.app, APP_KEYS, `${label}app.`));
  return w;
}

/** Is this a suite (top-level `specs` array) vs a single spec? */
function looksLikeSuite(data: unknown): boolean {
  return !!data && typeof data === "object" && Array.isArray((data as { specs?: unknown }).specs);
}

const TOKEN_RE = /\{\{[^}]+\}\}/g;

/**
 * Neutralize template tokens that didn't resolve (e.g. `{{env.X}}` with the var
 * unset). A field that is *entirely* a token is deferred to runtime, so we
 * stand in a valid URL-shaped placeholder; embedded tokens become a word. This
 * keeps validation about structure, not which env vars happen to be set.
 */
function neutralizeTemplates<T>(value: T): T {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    if (/^(\s*\{\{[^}]+\}\}\s*)+$/.test(value)) return "https://templated.example" as unknown as T;
    return value.replace(TOKEN_RE, "x") as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => neutralizeTemplates(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = neutralizeTemplates(v);
    return out as T;
  }
  return value;
}

/**
 * Validate a loaded spec or suite. Templates are resolved first (so `{{env.X}}`
 * with a set var validates cleanly). For a suite we ALSO validate every spec
 * (and the login spec) against TestSpecSchema after defaults are applied —
 * SuiteSchema alone treats specs as opaque records.
 */
export function validateSpecData(data: unknown, ctx?: TemplateContext): ValidationResult {
  const rendered = neutralizeTemplates(applyTemplates(data, ctx ?? makeContext()));

  if (looksLikeSuite(rendered)) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const parsed = SuiteSchema.safeParse(rendered);
    if (!parsed.success) errors.push(...formatIssues("", parsed.error));
    if (isPlainObject(rendered)) warnings.push(...unknownKeyWarnings(rendered, SUITE_KEYS, ""));

    // Validate each concrete spec (the part SuiteSchema can't check).
    const suite = (parsed.success ? parsed.data : (rendered as Suite)) as Suite;
    const checkSpec = (raw: Record<string, unknown>, label: string) => {
      const merged = applyDefaults(raw, suite.defaults);
      const r = TestSpecSchema.safeParse(merged);
      if (!r.success) errors.push(...formatIssues(`${label} → `, r.error));
      warnings.push(...specWarnings(raw, `${label} → `));
    };
    if (suite.login) checkSpec(suite.login, "login");
    (suite.specs ?? []).forEach((s, i) => checkSpec(s, `spec[${i}]${s.title ? ` "${s.title}"` : ""}`));

    return { kind: "suite", ok: errors.length === 0, errors, warnings };
  }

  const r = TestSpecSchema.safeParse(rendered);
  const warnings = isPlainObject(rendered) ? specWarnings(rendered, "") : [];
  return { kind: "spec", ok: r.success, errors: r.success ? [] : formatIssues("", r.error), warnings };
}
