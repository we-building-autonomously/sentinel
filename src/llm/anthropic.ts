import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import type { UsageMeter } from "../usage.js";

export interface LlmTurn {
  /** Free text the model produced before/around tool use. */
  text: string;
  /** Tool calls the model wants to make this turn. */
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** Raw assistant content blocks, to append to history verbatim. */
  raw: ContentBlockParam[];
  stopReason: string | null;
  usage: { input: number; output: number };
}

/**
 * Thin, resilient wrapper around the Anthropic Messages API.
 *
 * Responsibilities:
 *  - retries with exponential backoff on 429/5xx/overloaded
 *  - prompt caching of the (large, stable) system prompt + tool defs
 *  - a clean turn-based interface for the agent loop
 */
/** The slice of the Anthropic SDK the client uses (injectable for tests). */
export interface MessagesApi {
  messages: { create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Message> };
}

/** Which HTTP statuses are worth retrying: rate limit, overloaded, server error. */
export function isRetriableStatus(status?: number): boolean {
  return status === 429 || status === 529 || (status != null && status >= 500);
}

/**
 * Extract a Retry-After delay (ms) from an API error, honoring the server's
 * own rate-limit pacing. Reads the `retry-after` header (seconds) from either a
 * Headers instance or a plain object. Returns null when absent/unparseable so
 * the caller falls back to exponential backoff. Capped at 60s for sanity.
 */
export function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: unknown })?.headers;
  if (!headers) return null;
  let raw: string | null | undefined;
  if (typeof (headers as Headers).get === "function") raw = (headers as Headers).get("retry-after");
  else raw = (headers as Record<string, string>)["retry-after"] ?? (headers as Record<string, string>)["Retry-After"];
  if (raw == null) return null;
  const secs = Number(String(raw).trim());
  if (!Number.isFinite(secs) || secs < 0) return null; // HTTP-date form unsupported -> backoff
  return Math.min(secs * 1000, 60_000);
}

export class LlmClient {
  private client: MessagesApi;

  /** Sleep + jitter source, injectable so retry/backoff is testable without real waits. */
  private sleep: (ms: number) => Promise<void>;
  private rng: () => number;
  /** Models that rejected `temperature` (deprecated on newer models) — omit it for them. */
  private noTemperature = new Set<string>();
  /** Cheaper models to try, in order, when the primary is rate-limited after retries. */
  private fallbacks: string[];
  /** Called when a request is served by a fallback model instead of the primary. */
  private onFallback?: (info: { from: string; to: string; reason: string }) => void;

  constructor(
    apiKey: string,
    private model: string,
    private meter?: UsageMeter,
    private maxRetries = 5,
    /** Inject a stand-in Anthropic client for deterministic tests. */
    clientImpl?: MessagesApi,
    /** Test seams + behavior: deterministic backoff, and the 429 fallback ladder. */
    opts?: {
      sleep?: (ms: number) => Promise<void>;
      rng?: () => number;
      fallbacks?: string[];
      onFallback?: (info: { from: string; to: string; reason: string }) => void;
    }
  ) {
    this.client = clientImpl ?? new Anthropic({ apiKey });
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rng = opts?.rng ?? Math.random;
    this.fallbacks = opts?.fallbacks ?? [];
    this.onFallback = opts?.onFallback;
  }

  /** Delay before the next retry: Retry-After if the server gave one, else exp backoff + jitter. */
  private retryDelayMs(attempt: number, err: unknown): number {
    const ra = retryAfterMs(err);
    if (ra != null) return ra;
    const backoff = Math.min(1000 * 2 ** attempt, 30_000);
    return backoff + backoff * 0.25 * this.rng();
  }

  /** Record a response's token usage against the shared meter, if present. */
  private meterUsage(model: string, res: Message): void {
    if (!this.meter) return;
    const u = res.usage;
    this.meter.record(model, {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }

  /**
   * Run one model turn. `system` and `tools` are cached across calls.
   */
  async turn(opts: {
    system: string;
    tools?: Tool[];
    messages: MessageParam[];
    maxTokens?: number;
    model?: string;
    temperature?: number;
  }): Promise<LlmTurn> {
    const tools = opts.tools?.map((t, i) =>
      // Cache the last tool definition -> caches the whole tools+system prefix.
      i === (opts.tools!.length - 1)
        ? ({ ...t, cache_control: { type: "ephemeral" } } as Tool)
        : t
    );

    const res = await this.sendWithFallback({
      model: opts.model ?? this.model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0,
      system: [
        {
          type: "text",
          text: opts.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools,
      messages: opts.messages,
    });
    this.meterUsage(opts.model ?? this.model, res);

    const toolUses: LlmTurn["toolUses"] = [];
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use")
        toolUses.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
    }

    return {
      text,
      toolUses,
      raw: res.content as ContentBlockParam[],
      stopReason: res.stop_reason,
      usage: {
        input: res.usage.input_tokens,
        output: res.usage.output_tokens,
      },
    };
  }

  /** Single-shot JSON completion using a forced tool call as the schema gate. */
  async structured<T>(opts: {
    system: string;
    prompt: string | ContentBlockParam[];
    schema: Tool["input_schema"];
    toolName: string;
    model?: string;
    maxTokens?: number;
  }): Promise<T> {
    const tool: Tool = {
      name: opts.toolName,
      description: "Return the result in this structured form.",
      input_schema: opts.schema,
    };
    const model = opts.model ?? this.model;
    const messages: MessageParam[] = [
      {
        role: "user",
        content: typeof opts.prompt === "string" ? [{ type: "text", text: opts.prompt }] : opts.prompt,
      },
    ];

    // A forced tool call whose JSON got cut off by max_tokens yields a partial,
    // unparseable input. Retry once with a doubled budget before giving up.
    let budget = opts.maxTokens ?? 2048;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.sendWithFallback({
        model,
        max_tokens: budget,
        temperature: 0,
        system: opts.system,
        tools: [tool],
        tool_choice: { type: "tool", name: opts.toolName },
        messages,
      });
      this.meterUsage(model, res);
      const block = res.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use")
        throw new Error("Model did not return structured output");

      // Truncated output -> the tool input is incomplete; retry with more room.
      if (res.stop_reason === "max_tokens" && attempt === 0) {
        budget = Math.min(budget * 2, 8192);
        continue;
      }
      return block.input as T;
    }
    throw new Error("Structured output truncated even after increasing the token budget");
  }

  /**
   * Issue a request with retry, then — only if it still fails with a rate-limit
   * / overloaded status after exhausting retries — retry on each configured
   * cheaper fallback model in turn. A sustained 429 on the primary thus degrades
   * to a working (if weaker) model instead of failing the run with no output. A
   * non-retriable error (auth, bad request) on either the primary or a fallback
   * is surfaced immediately rather than masked by the next model.
   */
  private async sendWithFallback(params: MessageCreateParamsNonStreaming): Promise<Message> {
    try {
      return await this.withRetry(() => this.createMessage(params));
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (!isRetriableStatus(status) || this.fallbacks.length === 0) throw err;
      let lastErr = err;
      for (const fb of this.fallbacks) {
        if (fb === params.model) continue;
        try {
          const res = await this.withRetry(() => this.createMessage({ ...params, model: fb }));
          this.onFallback?.({ from: params.model, to: fb, reason: `HTTP ${status}` });
          return res;
        } catch (e) {
          lastErr = e;
          // A real error on the fallback (auth/bad request) isn't a quota issue —
          // don't keep walking the ladder hiding it; surface it.
          if (!isRetriableStatus((e as { status?: number })?.status)) throw e;
        }
      }
      throw lastErr;
    }
  }

  /**
   * Create a message, self-healing the `temperature` parameter: newer models
   * (e.g. claude-opus-4-8) reject `temperature` with a 400. The first time a
   * model does, we drop the param, remember the model, and retry — so a single
   * deprecation never costs a verdict, with no brittle per-model allowlist.
   */
  private async createMessage(params: MessageCreateParamsNonStreaming): Promise<Message> {
    const p = this.noTemperature.has(params.model) ? { ...params, temperature: undefined } : params;
    try {
      return await this.client.messages.create(p);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = (err as { message?: string })?.message ?? "";
      if (status === 400 && /\btemperature\b/i.test(message) && p.temperature !== undefined) {
        this.noTemperature.add(params.model);
        return await this.client.messages.create({ ...params, temperature: undefined });
      }
      throw err;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number })?.status;
        if (!isRetriableStatus(status) || attempt === this.maxRetries) break;
        await this.sleep(this.retryDelayMs(attempt, err));
      }
    }
    throw lastErr;
  }
}
