import type { PageProfile } from "./browser/profile.js";

/**
 * Minimal slice of LlmClient this module needs (keeps tests cast-free). `prompt`
 * and `schema` are widened so the real LlmClient (stricter param types) remains
 * assignable to this interface under function-parameter contravariance.
 */
export interface StructuredLlm {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structured<T>(opts: { system: string; prompt: any; schema: any; toolName: string; maxTokens?: number }): Promise<T>;
}

export interface DraftCase {
  title: string;
  task: string;
  intent: string;
  tags: string[];
}

const DRAFT_SYSTEM = `You are a senior QA engineer. Given a structural profile of a web page, write concrete, independent end-to-end test cases that a real user would perform — the kind you'd hand to a manual tester or automate.

Each case has:
- title: a short imperative name.
- task: the exact user actions to perform, in order, grounded in the page's real forms/buttons/links.
- intent: the observable success condition (a visible message, a value, a URL/page change) — never internal state.
- tags: 1-3 short labels (e.g. smoke, auth, search, form).

Cover the page's primary flows. Prefer happy paths plus one meaningful validation/error case when a form is present. Keep each case self-contained.`;

function profilePrompt(profile: PageProfile, count: number): string {
  const forms = profile.forms
    .map((f, i) => `  form ${i + 1}: [${f.fields.join(", ")}]${f.hasPassword ? " (password)" : ""}${f.submitLabel ? ` submit="${f.submitLabel}"` : ""}`)
    .join("\n");
  return [
    `URL: ${profile.url}`,
    `Title: ${profile.title}`,
    profile.headings.length ? `Headings: ${profile.headings.join(" | ")}` : "",
    profile.primaryActions.length ? `Primary actions: ${profile.primaryActions.join(" | ")}` : "",
    forms ? `Forms:\n${forms}` : "",
    profile.hasLogin ? "A login form is present." : "",
    ``,
    `Write ${count} test case(s) for this page.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const DRAFT_SCHEMA = {
  type: "object" as const,
  properties: {
    specs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          task: { type: "string" },
          intent: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title", "task", "intent"],
      },
    },
  },
  required: ["specs"],
};

interface RawDraft {
  specs: Array<{ title: string; task: string; intent: string; tags?: string[] }>;
}

/** Ask the model to draft grounded test cases from a page profile. */
export async function draftSpecs(
  llm: StructuredLlm,
  profile: PageProfile,
  opts: { count?: number } = {}
): Promise<DraftCase[]> {
  const count = Math.max(1, Math.min(opts.count ?? 3, 10));
  const raw = await llm.structured<RawDraft>({
    system: DRAFT_SYSTEM,
    prompt: profilePrompt(profile, count),
    schema: DRAFT_SCHEMA,
    toolName: "draft_specs",
    maxTokens: 2000,
  });
  return (raw.specs ?? []).map((s) => ({
    title: s.title,
    task: s.task,
    intent: s.intent,
    tags: s.tags?.length ? s.tags : ["smoke"],
  }));
}

function q(s: string): string {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function appName(profile: PageProfile, name?: string): string {
  return name ?? profile.title?.split(/[|\-–—·]/)[0].trim() ?? profile.url;
}

/** Compose drafted cases into a Sentinel suite (object + commented YAML). */
export function draftedSuite(
  profile: PageProfile,
  cases: DraftCase[],
  opts: { name?: string } = {}
): { suite: Record<string, unknown>; yaml: string } {
  const name = appName(profile, opts.name);
  const app: Record<string, unknown> = { name, url: profile.url };
  if (profile.hasLogin) app.auth = { username: "TODO@example.com", password: "TODO" };

  const suite: Record<string, unknown> = {
    name: `${name} suite`,
    defaults: { app },
    specs: cases.map((c) => ({ title: c.title, tags: c.tags, task: c.task, intent: c.intent })),
  };

  const lines: string[] = [
    `# Drafted by 'sentinel init --draft' from ${profile.url}`,
    profile.hasLogin ? `# Fill in real credentials under defaults.app.auth (redacted in reports).` : `# Review the cases, then run:  sentinel suite this-file.yaml`,
    ``,
    `name: ${q(String(suite.name))}`,
    `defaults:`,
    `  app:`,
    `    name: ${q(name)}`,
    `    url: ${q(profile.url)}`,
  ];
  if (profile.hasLogin) {
    lines.push(`    auth:`, `      username: "TODO@example.com"`, `      password: "TODO"`);
  }
  lines.push(`specs:`);
  for (const c of cases) {
    lines.push(
      `  - title: ${q(c.title)}`,
      `    tags: [${c.tags.join(", ")}]`,
      `    task: ${q(c.task)}`,
      `    intent: ${q(c.intent)}`
    );
  }
  return { suite, yaml: lines.join("\n") + "\n" };
}
