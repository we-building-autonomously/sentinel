/**
 * Preflight environment checks. The logic is pure over an injected snapshot so
 * it is fully unit-testable; the CLI gathers the real values (node version,
 * env, browser path, fs/network probes) and passes them in.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorInput {
  /** e.g. process.version ("v26.0.0"). */
  nodeVersion: string;
  /** ANTHROPIC_API_KEY value, if set. */
  apiKey?: string;
  /** Path to the installed Chromium, or null if not found. */
  browserPath?: string | null;
  /** Whether the runs output directory is writable. */
  runsWritable: boolean;
  /** Optional async probe: resolves true if the Anthropic API is reachable. */
  ping?: () => Promise<boolean>;
  /**
   * Optional async probe that actually launches + closes the browser. Catches
   * the common "binary present but missing OS shared libs" failure that a path
   * check can't — the real "will it run here?" test.
   */
  launch?: () => Promise<{ ok: boolean; error?: string }>;
  /** Status of sentinel.config.json (present/valid/unknown keys/apiKey leak). */
  configFile?: {
    present: boolean;
    valid: boolean;
    unknownKeys: string[];
    hasApiKey: boolean;
    error?: string;
  };
}

const MIN_NODE = 20;

function majorOf(version: string): number {
  const m = /v?(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}

export async function runDoctor(input: DoctorInput): Promise<Check[]> {
  const checks: Check[] = [];

  const major = majorOf(input.nodeVersion);
  checks.push({
    name: "Node.js",
    status: major >= MIN_NODE ? "ok" : "fail",
    detail: major >= MIN_NODE ? `${input.nodeVersion} (>= ${MIN_NODE})` : `${input.nodeVersion} — Sentinel needs Node ${MIN_NODE}+`,
  });

  checks.push({
    name: "API key",
    status: input.apiKey ? "ok" : "warn",
    detail: input.apiKey
      ? "ANTHROPIC_API_KEY is set"
      : "ANTHROPIC_API_KEY not set — required for run/suite (init, watch, history work without it). Get a key: https://console.anthropic.com/settings/keys",
  });

  checks.push({
    name: "Chromium",
    status: input.browserPath ? "ok" : "fail",
    detail: input.browserPath ? `installed at ${input.browserPath}` : "not installed — run: npx playwright install chromium",
  });

  // A binary on disk isn't the same as a browser that launches — exercise it.
  // (Skip if it isn't even installed; the check above already failed.)
  if (input.launch && input.browserPath) {
    let res: { ok: boolean; error?: string };
    try {
      res = await input.launch();
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    checks.push({
      name: "Browser launch",
      status: res.ok ? "ok" : "fail",
      detail: res.ok
        ? "Chromium launches cleanly"
        : `Chromium failed to launch: ${(res.error ?? "unknown error").split("\n")[0].slice(0, 160)} — try: npx playwright install-deps`,
    });
  }

  checks.push({
    name: "Output dir",
    status: input.runsWritable ? "ok" : "warn",
    detail: input.runsWritable ? "runs/ is writable" : "runs/ is not writable — reports can't be saved",
  });

  // Config file: a malformed or typo'd sentinel.config.json is silently ignored,
  // so a user's settings mysteriously don't take effect. Surface it.
  const cf = input.configFile;
  if (cf?.present) {
    if (!cf.valid) {
      checks.push({ name: "Config file", status: "warn", detail: `sentinel.config.json is invalid (${cf.error}) — ignored` });
    } else if (cf.unknownKeys.length || cf.hasApiKey) {
      const parts = [
        ...(cf.unknownKeys.length ? [`unknown key(s): ${cf.unknownKeys.join(", ")} (typo?)`] : []),
        ...(cf.hasApiKey ? ["apiKey is ignored — set ANTHROPIC_API_KEY in env/.env instead"] : []),
      ];
      checks.push({ name: "Config file", status: "warn", detail: `sentinel.config.json: ${parts.join("; ")}` });
    } else {
      checks.push({ name: "Config file", status: "ok", detail: "sentinel.config.json loaded" });
    }
  }

  if (input.ping) {
    let reachable = false;
    try {
      reachable = await input.ping();
    } catch {
      reachable = false;
    }
    checks.push({
      name: "API reachable",
      status: reachable ? "ok" : "warn",
      detail: reachable ? "api.anthropic.com responded" : "could not reach api.anthropic.com (offline or blocked?)",
    });
  }

  return checks;
}

export function summarizeDoctor(checks: Check[]): { ok: number; warn: number; fail: number } {
  return {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
}

/** Exit code: non-zero only when a hard check failed. */
export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
