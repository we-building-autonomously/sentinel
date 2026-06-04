import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { runSpec as defaultRunSpec, type RunOptions } from "./runner.js";
import { buildInlineSpec } from "./inline-spec.js";
import { scanRuns } from "./report/history.js";
import type { RunReport, Step } from "./types.js";
import { UI_HTML } from "./server-ui.js";

/**
 * Live web dashboard: trigger a test from a browser and watch every harness
 * event (phase changes, each agent action, the final verdict) stream in over
 * Server-Sent Events. The runner already emits onPhase/onStep — this exposes
 * them. `run` is injectable so the streaming can be tested without a browser.
 */
export interface ServeOptions {
  port?: number;
  runsDir?: string;
  /** Injected runner (defaults to the real runSpec). */
  run?: (spec: unknown, options: RunOptions) => Promise<RunReport>;
}

/** One SSE frame: `event:<type>\ndata:<json>\n\n`. Pure, for testing. */
export function sseFrame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The body the UI POSTs to /api/run. */
export interface RunRequest {
  url?: string;
  task?: string;
  intent?: string;
  user?: string;
  pass?: string;
  headed?: boolean;
}

function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Stream a run as SSE, translating the runner's callbacks into frames. Returns
 * once the run finishes (or errors). `write` is the SSE sink. Pure of HTTP so
 * it can be unit-tested with a string-collecting sink.
 */
export async function streamRun(
  body: RunRequest,
  write: (frame: string) => void,
  opts: ServeOptions = {}
): Promise<void> {
  const run = opts.run ?? defaultRunSpec;
  const built = buildInlineSpec({
    url: body.url ?? "",
    task: body.task ?? "",
    intent: body.intent,
    user: body.user,
    pass: body.pass,
  });
  if (!built.ok) {
    write(sseFrame("error", { message: built.errors.join("; ") }));
    write(sseFrame("done", { ok: false }));
    return;
  }
  const meta = built.spec as { title?: string; app?: { url?: string } };
  write(sseFrame("started", { title: meta.title ?? "Untitled", url: meta.app?.url ?? "" }));
  try {
    let runFolder = "";
    const report = await run(built.spec, {
      config: { headed: body.headed || undefined, ...(opts.runsDir ? { runsDir: opts.runsDir } : {}) },
      onStart: ({ runDir }) => (runFolder = path.basename(runDir)),
      onPhase: (phase) => write(sseFrame("phase", { phase })),
      onStep: (s: Step) =>
        write(
          sseFrame("step", {
            index: s.index,
            tool: s.call.name,
            input: s.call.input,
            ok: s.result.ok,
            summary: s.result.summary,
            thought: s.thought,
            // Live screenshot of the page after this action, served from /runs/.
            screenshot: s.result.screenshot && runFolder ? `/runs/${runFolder}/${s.result.screenshot}` : undefined,
          })
        ),
    });
    write(
      sseFrame("verdict", {
        decision: report.verdict.decision,
        confidence: report.verdict.confidence,
        summary: report.verdict.summary,
        checkpoints: report.verdict.checkpoints.map((c) => ({ description: c.description, status: c.status })),
        issues: report.verdict.issues,
        triage: report.triage?.category ?? null,
        durationMs: report.durationMs,
        costUsd: report.usage?.costUsd ?? 0,
        reportUrl: `/runs/${path.basename(report.runDir)}/report.html`,
      })
    );
    write(sseFrame("done", { ok: true }));
  } catch (err) {
    write(sseFrame("error", { message: err instanceof Error ? err.message.split("\n")[0] : String(err) }));
    write(sseFrame("done", { ok: false }));
  }
}

export interface RunListItem {
  title: string;
  decision: string;
  category: string;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  reportUrl: string;
}

/** Past runs under `runsDir`, newest first, mapped for the dashboard history panel. */
export function listRuns(runsDir: string, limit = 50): RunListItem[] {
  return scanRuns(runsDir)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, limit)
    .map((s) => ({
      title: s.title,
      decision: s.decision,
      category: s.category ?? "inconclusive",
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      costUsd: s.costUsd,
      reportUrl: `/runs/${path.basename(s.runDir)}/report.html`,
    }));
}

/** Resolve a `/runs/<dir>/<file>` request to a safe absolute path, or null. */
export function resolveRunsFile(urlPath: string, runsDir: string): string | null {
  const rel = decodeURIComponent(urlPath.replace(/^\/runs\//, ""));
  const base = path.resolve(runsDir);
  const full = path.resolve(base, rel);
  // Path-traversal guard: the resolved path must stay inside runsDir.
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".md": "text/markdown; charset=utf-8",
};

export function createServer(opts: ServeOptions = {}): http.Server {
  const runsDir = opts.runsDir ?? path.resolve("runs");
  return http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? "/").split("?")[0];

      if (req.method === "GET" && url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(UI_HTML);
        return;
      }

      if (req.method === "POST" && url === "/api/run") {
        const body = JSON.parse((await readBody(req)) || "{}") as RunRequest;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        await streamRun(body, (frame) => res.write(frame), { ...opts, runsDir });
        res.end();
        return;
      }

      if (req.method === "GET" && url === "/api/runs") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(listRuns(runsDir)));
        return;
      }

      if (req.method === "GET" && url.startsWith("/runs/")) {
        const file = resolveRunsFile(url, runsDir);
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404).end("Not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
        return;
      }

      res.writeHead(404).end("Not found");
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : "Server error");
    }
  });
}
