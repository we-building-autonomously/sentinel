/**
 * Build a one-off TestSpec from command-line flags, so a user can run a quick
 * check without authoring a YAML file:
 *
 *   sentinel try https://app.dev --task "log in and open settings" \
 *                --intent "the settings page is shown" --user me@x.com --pass hunter2
 *
 * Pure and validation-only here — the returned object is handed to runSpec,
 * which parses it through the full TestSpec schema (so URL validity etc. is
 * enforced there). We only check the inputs a CLI user is likely to omit and
 * give a friendly, specific error.
 */
export interface InlineSpecInput {
  url?: string;
  task?: string;
  intent?: string;
  name?: string;
  user?: string;
  pass?: string;
  a11y?: boolean;
  viewport?: string;
  criteria?: string[];
  /** Text that must appear on the final page. */
  expectText?: string[];
  /** Text that must NOT appear on the final page. */
  forbidText?: string[];
  /** Substrings the final page URL must contain. */
  expectUrl?: string[];
  /** Substrings the final page URL must NOT contain. */
  forbidUrl?: string[];
}

export interface InlineSpecResult {
  ok: boolean;
  spec?: Record<string, unknown>;
  errors: string[];
}

/** Default success definition when the user gives a task but no explicit intent. */
export function defaultIntent(task: string): string {
  return `The task "${task}" completes successfully and the expected end state is visible.`;
}

export function buildInlineSpec(input: InlineSpecInput): InlineSpecResult {
  const errors: string[] = [];
  const url = input.url?.trim();
  const task = input.task?.trim();
  if (!url) errors.push("a target URL is required (the first argument)");
  if (!task) errors.push('--task "what the user should do" is required');
  if (errors.length) return { ok: false, errors };

  const app: Record<string, unknown> = { url };
  if (input.user?.trim() || input.pass != null) {
    app.auth = {
      ...(input.user?.trim() ? { username: input.user.trim() } : {}),
      ...(input.pass != null ? { password: input.pass } : {}),
    };
  }

  const spec: Record<string, unknown> = {
    title: input.name?.trim() || task!.slice(0, 60),
    task,
    intent: input.intent?.trim() || defaultIntent(task!),
    app,
  };
  if (input.a11y) spec.a11y = true;
  if (input.viewport?.trim()) spec.viewport = input.viewport.trim();
  const criteria = input.criteria?.map((c) => c.trim()).filter(Boolean);
  if (criteria?.length) spec.criteria = criteria;
  const expectText = input.expectText?.map((t) => t.trim()).filter(Boolean);
  if (expectText?.length) spec.expectText = expectText;
  const forbidText = input.forbidText?.map((t) => t.trim()).filter(Boolean);
  if (forbidText?.length) spec.forbidText = forbidText;
  const expectUrl = input.expectUrl?.map((t) => t.trim()).filter(Boolean);
  if (expectUrl?.length) spec.expectUrl = expectUrl;
  const forbidUrl = input.forbidUrl?.map((t) => t.trim()).filter(Boolean);
  if (forbidUrl?.length) spec.forbidUrl = forbidUrl;

  return { ok: true, spec, errors: [] };
}
