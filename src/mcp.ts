import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runSpec as defaultRunSpec, type RunOptions } from "./runner.js";
import { buildInlineSpec } from "./inline-spec.js";
import { toQaResult, summarize, type QaResult } from "./qa-result.js";
import { reportRun } from "./cloud.js";
import type { RunReport } from "./types.js";

// Re-exported for back-compat (these used to live here; index.ts re-exports them).
export { toQaResult, summarize, type QaResult } from "./qa-result.js";

/**
 * Model Context Protocol server — exposes Sentinel's QA loop as a tool any
 * MCP-capable coding agent (Claude Code, Cursor, a custom harness) can call.
 *
 * The agent hands over what it just built — the app URL, the task a user would
 * perform, and what success looks like — and gets back a structured pass/fail
 * verdict with per-checkpoint reasoning, so it can self-correct. This is the
 * portable contract; the Claude Code plugin (command + hook) wraps it.
 *
 * `run` is injectable so the tool wiring can be tested without a browser/API.
 */
export interface McpOptions {
  /** Injected runner (defaults to the real runSpec). */
  run?: (spec: unknown, options: RunOptions) => Promise<RunReport>;
}

const QA_INPUT = {
  url: z.string().describe("The running app's URL to drive a real browser against."),
  task: z.string().describe('What a real user should do, e.g. "log in and create a project".'),
  intent: z
    .string()
    .optional()
    .describe("What success looks like — the observable end state. Defaults to: the task completes."),
  user: z.string().optional().describe("Login username/email, if the app requires auth."),
  pass: z.string().optional().describe("Login password, if the app requires auth."),
  expectText: z.array(z.string()).optional().describe("Text that MUST appear on the final page."),
  forbidText: z.array(z.string()).optional().describe("Text that must NOT appear on the final page."),
  a11y: z.boolean().optional().describe("Also run an accessibility (axe-core) audit of the final page."),
};

/** Build the MCP server with both tools registered. Pure of any transport. */
export function createMcpServer(options: McpOptions = {}): McpServer {
  const run = options.run ?? defaultRunSpec;
  const server = new McpServer({ name: "sentinel", version: "0.1.0" });

  server.registerTool(
    "sentinel_qa",
    {
      title: "QA a task in a real browser",
      description:
        "Drive a real browser like a user to verify a task works end-to-end, and return a strict " +
        "pass/fail verdict with per-checkpoint reasoning. Use after building or changing a feature to " +
        "confirm it actually works for a user — not just that the code compiles.",
      inputSchema: QA_INPUT,
    },
    async (input) => {
      const built = buildInlineSpec(input);
      if (!built.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid QA request: ${built.errors.join("; ")}` }],
        };
      }
      let report: RunReport;
      try {
        report = await run(built.spec!, { config: { headed: false } });
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `QA run failed to start: ${(err as Error).message}` }],
        };
      }
      await reportRun(report); // → Sentinel Cloud, if configured (no-op otherwise)
      const result = toQaResult(report);
      return {
        content: [{ type: "text", text: summarize(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

/** Launch the server over stdio (how an MCP client spawns it). */
export async function startMcpServer(options: McpOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
