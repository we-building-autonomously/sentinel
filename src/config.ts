import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export interface SentinelConfig {
  apiKey: string;
  /**
   * CDP/websocket endpoint of a REMOTE browser to drive instead of launching a
   * local Chromium (e.g. Browserbase/Browserless). Enables hosted execution —
   * the cloud runs the engine against a remote browser. Env-only (it embeds a
   * provider token), and never printed by `doctor`.
   */
  cdpEndpoint?: string;
  model: string;
  judgeModel: string;
  maxSteps: number;
  headed: boolean;
  /** Per-action navigation/wait timeout in ms. */
  actionTimeoutMs: number;
  /** Wall-clock budget for a single spec run, in ms (0 = no limit). */
  maxDurationMs: number;
  /** Record a video of each run. */
  video: boolean;
  /** Root directory where run artifacts are written. */
  runsDir: string;
  /** Directory holding visual-regression baseline screenshots. */
  baselinesDir: string;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Read project defaults from `sentinel.config.json` in `dir` (cwd). Returns {}
 * if absent or malformed. The API key is NEVER taken from a committed file —
 * it must come from the environment or an explicit override.
 */
export function readConfigFile(dir: string = process.cwd()): Partial<SentinelConfig> {
  try {
    const p = path.join(dir, "sentinel.config.json");
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const { apiKey: _dropApiKey, ...rest } = data;
    return rest as Partial<SentinelConfig>;
  } catch {
    return {};
  }
}

/** Recognized keys in sentinel.config.json (apiKey is intentionally excluded). */
const KNOWN_CONFIG_KEYS = new Set([
  "model",
  "judgeModel",
  "maxSteps",
  "headed",
  "actionTimeoutMs",
  "maxDurationMs",
  "video",
  "runsDir",
  "baselinesDir",
]);

export interface ConfigFileStatus {
  present: boolean;
  valid: boolean;
  /** Keys that aren't recognized (likely typos) — silently ignored at runtime. */
  unknownKeys: string[];
  /** True if the file (mistakenly) contains apiKey — it is ignored for security. */
  hasApiKey: boolean;
  error?: string;
}

/**
 * Inspect `sentinel.config.json` so `doctor` can warn about a malformed or
 * typo'd config that would otherwise be silently ignored (`readConfigFile`
 * returns {} for both "absent" and "broken").
 */
export function inspectConfigFile(dir: string = process.cwd()): ConfigFileStatus {
  const p = path.join(dir, "sentinel.config.json");
  if (!fs.existsSync(p)) return { present: false, valid: true, unknownKeys: [], hasApiKey: false };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { present: true, valid: false, unknownKeys: [], hasApiKey: false, error: "not a JSON object" };
    }
    const keys = Object.keys(data);
    return {
      present: true,
      valid: true,
      unknownKeys: keys.filter((k) => k !== "apiKey" && !KNOWN_CONFIG_KEYS.has(k)),
      hasApiKey: keys.includes("apiKey"),
    };
  } catch (e) {
    return { present: true, valid: false, unknownKeys: [], hasApiKey: false, error: e instanceof Error ? e.message.split("\n")[0] : "parse error" };
  }
}

/** Resolve every non-secret field (overrides → env → file → default). */
function resolveDefaults(
  overrides: Partial<SentinelConfig>,
  file: Partial<SentinelConfig>
): Omit<SentinelConfig, "apiKey"> {
  return {
    model: overrides.model ?? process.env.SENTINEL_MODEL ?? file.model ?? "claude-sonnet-4-6",
    judgeModel:
      overrides.judgeModel ?? process.env.SENTINEL_JUDGE_MODEL ?? file.judgeModel ?? "claude-opus-4-8",
    maxSteps:
      overrides.maxSteps ?? (Number(process.env.SENTINEL_MAX_STEPS ?? "") || file.maxSteps || 40),
    headed: overrides.headed ?? bool(process.env.SENTINEL_HEADED, file.headed ?? false),
    actionTimeoutMs: overrides.actionTimeoutMs ?? file.actionTimeoutMs ?? 15_000,
    maxDurationMs:
      overrides.maxDurationMs ??
      (Number(process.env.SENTINEL_MAX_DURATION_MS ?? "") || file.maxDurationMs || 5 * 60_000),
    video: overrides.video ?? bool(process.env.SENTINEL_VIDEO, file.video ?? false),
    runsDir: overrides.runsDir ?? file.runsDir ?? "runs",
    baselinesDir: overrides.baselinesDir ?? file.baselinesDir ?? "baselines",
  };
}

/**
 * Resolve config. Precedence (highest first): explicit overrides (CLI) →
 * environment → `sentinel.config.json` → built-in defaults.
 */
export function loadConfig(
  overrides: Partial<SentinelConfig> = {},
  file: Partial<SentinelConfig> = readConfigFile()
): SentinelConfig {
  const apiKey = overrides.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set.\n" +
      "\n" +
      "  Get a key → https://console.anthropic.com/settings/keys\n" +
      "\n" +
      "  Then set it in one of these ways:\n" +
      "    • shell:   export ANTHROPIC_API_KEY=sk-ant-…\n" +
      "    • .env:    echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env\n" +
      "    • CI:      add it as a repository secret named ANTHROPIC_API_KEY"
    );
  }
  // Endpoint of a remote browser to drive (hosted execution). Like apiKey, it's
  // env/override-only — never read from the committed config file, since the
  // provider URL typically carries a token.
  const cdpEndpoint = overrides.cdpEndpoint ?? process.env.SENTINEL_CDP_ENDPOINT ?? undefined;
  return { apiKey, ...(cdpEndpoint ? { cdpEndpoint } : {}), ...resolveDefaults(overrides, file) };
}

/**
 * The resolved non-secret config (model, dirs, limits) — for `doctor` to show
 * what's actually in effect. Never needs the API key, so it works on any box.
 */
export function configSummary(file: Partial<SentinelConfig> = readConfigFile()): Omit<SentinelConfig, "apiKey"> {
  return resolveDefaults({}, file);
}

/** Default Anthropic model ids for the fallback ladder. */
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5-20251001";

/**
 * Cheaper models to fall back to, in order, when the primary is 429-rate-limited
 * even after retries — so a quota-capped key degrades to a working model instead
 * of failing the whole run with "test plan could not be generated" and 0 steps.
 * Overridable via SENTINEL_FALLBACK_MODELS (comma-separated); set it empty to
 * disable fallback entirely.
 */
export function modelFallbacks(model: string): string[] {
  const env = process.env.SENTINEL_FALLBACK_MODELS;
  if (env != null) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((m) => m !== model);
  }
  if (/opus/i.test(model)) return [SONNET, HAIKU];
  if (/sonnet/i.test(model)) return [HAIKU];
  return [];
}
