#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { runSpec } from "./runner.js";
import { runSuite, expandCases } from "./suite.js";
import { createServer } from "./server.js";
import { withRetry } from "./retry.js";
import { toJUnit } from "./report/junit.js";
import { writeSuiteReport, summarize } from "./report/suite-report.js";
import { emitGithub, isGithubActions } from "./report/github.js";
import { toJsonReport, toJsonSuite } from "./report/json-report.js";
import { sumUsage, formatUsage } from "./usage.js";
import { BrowserSession } from "./browser/session.js";
import { profilePage } from "./browser/profile.js";
import { scaffoldSpec } from "./scaffold.js";
import { draftSpecs, draftedSuite } from "./draft.js";
import { LlmClient } from "./llm/anthropic.js";
import { UsageMeter } from "./usage.js";
import { loadConfig, configSummary, inspectConfigFile } from "./config.js";
import { notifySuite, notifyRegression } from "./notify.js";
import { watchAndRun, fileChangeSource } from "./watch.js";
import { writeHistory } from "./report/history.js";
import { runDoctor, summarizeDoctor, doctorExitCode } from "./doctor.js";
import { findApprovals, approveRun } from "./approve.js";
import { parseGates, qaGateFailures } from "./qa-gate.js";
import { parseShard } from "./filter.js";
import { parseTriageCategories, triageGateFailures } from "./triage-gate.js";
import { buildInlineSpec } from "./inline-spec.js";
import { startMcpServer } from "./mcp.js";
import { reportRun } from "./cloud.js";
import { findLatestReport, openerFor } from "./open.js";
import { validateSpecData } from "./validate.js";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import type { RunReport } from "./types.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function usage(): never {
  console.log(`Sentinel — browser-native testing harness

Usage:
  sentinel run   <spec.(json|yaml)> [spec2 ...] [--headed] [--max-steps N] [--junit out.xml]
                 [--storage-state in.json] [--save-state out.json] [--retries N] [--json] [--video] [--github]
                 [--viewport mobile|tablet|desktop|"iPhone 13"|WIDTHxHEIGHT]
                 [--fail-on a11y|a11y-critical|perf|visual|requests|errors|text|url|state|security|layout|downloads|clipboard|toast,...]
  sentinel suite <suite.(json|yaml)> [--concurrency N] [--retries N] [--budget USD] [--headed]
                 [--junit out.xml] [--tag NAME ...] [--grep PATTERN] [--shard i/n] [--github] [--notify WEBHOOK_URL]
                 [--json] [--video] [--viewports desktop,mobile] [--color-schemes light,dark] [--locales en-US,fr-FR]
                 [--fail-on a11y,perf,visual,requests,errors,text,url,state,security,layout,downloads,clipboard,toast]
                 [--fail-on-triage product-defect,blocked,... | actionable]
                 (a suite can declare a 'login' spec run once + reused across all specs)
  sentinel try   <url> --task "..." [--intent "..."] [--user U --pass P] [--name N]
                 [--a11y] [--viewport ...] [--headed] [--video] [--max-steps N] [--json]
                 [--expect-text "..."] [--forbid-text "..."]  (repeatable; assert page text)
                 [--expect-url "..."] [--forbid-url "..."]  (repeatable; assert final URL)
                 (quick one-off run from flags — no spec file needed)
  sentinel init  <url> [--out file.yaml] [--name NAME] [--draft] [--count N]
                 (profile a page and scaffold a spec; --draft uses the LLM to
                  write ready-to-run test cases — needs ANTHROPIC_API_KEY)
  sentinel watch <spec-or-suite.(json|yaml)> [--headed]
                 (re-run automatically whenever the file changes)
  sentinel history [--dir runs] [--out runs/index.html] [--fail-on-regression] [--fail-on-qa-drift] [--notify URL]
                 (aggregate past runs into a trend dashboard; gate CI on regressions / QA drift)
  sentinel serve [--port 3100]
                 (live web dashboard: trigger a test in the browser, watch events stream in)
  sentinel mcp
                 (MCP server on stdio: exposes the sentinel_qa tool to a coding agent)
  sentinel doctor
                 (preflight: Node, API key, Chromium, output dir, API reachability)
  sentinel approve [run-dir] [--all] [--dir runs]
                 (promote a visual-diff run's screenshot to its baseline)
  sentinel open  [--dir runs]
                 (open the latest report / dashboard in your browser)
  sentinel validate [file|dir ...]
                 (check spec/suite files against the schema — fast, no run)

A spec describes a test:
  {
    "title": "User can sign up",
    "task": "Create a new account with a fresh email and reach the dashboard",
    "intent": "After signup the user lands on an authenticated dashboard showing their email",
    "app": { "url": "https://app.example.com", "auth": { "username": "...", "password": "..." } }
  }

Reports (json/md/html) and screenshots are written under ./runs/.
Exit code: 0 pass · 1 fail · 2 inconclusive/error.`);
  process.exit(0);
}

function loadSpecFile(file: string): unknown {
  const raw = fs.readFileSync(file, "utf8");
  return /\.ya?ml$/i.test(file) ? parseYaml(raw) : JSON.parse(raw);
}

function printVerdict(r: RunReport): void {
  const v = r.verdict;
  const tag =
    v.decision === "pass"
      ? c.green("PASS")
      : v.decision === "fail"
        ? c.red("FAIL")
        : c.yellow("INCONCLUSIVE");
  const flaky = r.flaky ? c.yellow(" ⚠ FLAKY") : "";
  const attempts = r.attempts && r.attempts > 1 ? `, ${r.attempts} attempts` : "";
  const cost = r.usage ? `, ~$${r.usage.costUsd.toFixed(4)}` : "";
  console.log(`\n${c.bold(r.spec.title)} → ${tag}${flaky} ${c.dim(`(${(v.confidence * 100).toFixed(0)}% conf, ${r.steps.length} steps, ${(r.durationMs / 1000).toFixed(1)}s${attempts}${cost})`)}`);
  console.log(c.dim("  " + v.summary));
  for (const cp of v.checkpoints) {
    const mark = cp.status === "met" ? c.green("✓") : cp.status === "unmet" ? c.red("✗") : c.yellow("?");
    console.log(`  ${mark} ${cp.description}`);
  }
  if (v.issues.length) {
    console.log(c.yellow("  Issues:"));
    for (const i of v.issues) console.log(c.yellow(`    - ${i}`));
  }
  console.log(c.dim(`  report: ${path.relative(process.cwd(), r.runDir)}/report.html`));
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Collect every value of a repeatable flag (e.g. --expect-text "A" --expect-text "B"). */
function collectFlags(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] != null ? [args[i + 1]] : []));
}

async function suiteCommand(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || !fs.existsSync(file)) {
    console.error(c.red(`Suite file not found: ${file ?? "(none)"}`));
    process.exit(2);
  }
  const headed = args.includes("--headed");
  const json = args.includes("--json");
  const video = args.includes("--video");
  const concurrency = Number(flagValue(args, "--concurrency")) || undefined;
  const retries = Number(flagValue(args, "--retries")) || undefined;
  const budgetUsd = Number(flagValue(args, "--budget")) || undefined;
  const junitPath = flagValue(args, "--junit");
  const grep = flagValue(args, "--grep");
  const tags = args.flatMap((a, i) => (a === "--tag" ? [args[i + 1]] : [])).filter(Boolean);
  let shard;
  try {
    shard = parseShard(flagValue(args, "--shard"));
  } catch (err) {
    console.error(c.red((err as Error).message));
    process.exit(2);
  }
  const suite = loadSpecFile(file) as {
    name?: string;
    matrix?: { viewport?: string[]; colorScheme?: string[]; locale?: string[] };
  };
  const csv = (flag: string) => flagValue(args, flag)?.split(",").map((s) => s.trim()).filter(Boolean);
  const viewports = csv("--viewports");
  const colorSchemes = csv("--color-schemes");
  const locales = csv("--locales");
  if (viewports) suite.matrix = { ...suite.matrix, viewport: viewports };
  if (colorSchemes) suite.matrix = { ...suite.matrix, colorScheme: colorSchemes };
  if (locales) suite.matrix = { ...suite.matrix, locale: locales };
  const name = suite.name ?? path.basename(file);
  const log = (s: string) => (json ? process.stderr.write(s + "\n") : console.log(s));
  log(c.cyan(`\n▶ suite: ${name}`) + (shard ? c.dim(`  (shard ${shard.index}/${shard.total})`) : ""));

  const reports = await runSuite(suite, {
    concurrency,
    retries,
    budgetUsd,
    filter: { tags, grep },
    shard,
    config: { headed: headed || undefined, video: video || undefined },
    onSpecStart: (title) => log(c.dim(`  · start: ${title}`)),
    onSpecDone: (r) => (json ? undefined : printVerdict(r)),
  });

  if (!reports.length) {
    log(c.yellow(shard ? `No specs in shard ${shard.index}/${shard.total}.` : "No specs matched the filter."));
    // An empty shard is a normal, successful CI outcome — don't fail the worker.
    process.exitCode = shard ? 0 : 2;
    if (json) process.stdout.write(JSON.stringify(toJsonSuite([], name), null, 2) + "\n");
    return;
  }

  const gates = parseGates(flagValue(args, "--fail-on"));
  const dir = path.resolve("runs", `suite-${Date.now()}`);
  const indexPath = writeSuiteReport(dir, name, reports);
  if (junitPath) {
    fs.writeFileSync(junitPath, toJUnit(reports, name, gates));
    log(c.dim(`JUnit XML → ${junitPath}`));
  }
  const s = summarize(reports);
  const cost = sumUsage(reports.map((r) => r.usage));
  log(
    c.bold(`\n${s.pass}/${s.total} passed`) +
      c.dim(`  ·  ${formatUsage(cost)}  ·  report: ${path.relative(process.cwd(), indexPath)}`)
  );
  if (json) process.stdout.write(JSON.stringify(toJsonSuite(reports, name), null, 2) + "\n");

  // GitHub Actions: write the job summary + emit ::error/::warning:: annotations
  // (auto on inside a workflow, or forced with --github).
  if (args.includes("--github") || isGithubActions(process.env)) {
    const res = emitGithub({ reports, suiteName: name, env: process.env });
    if (res.summaryWritten) log(c.dim(`GitHub job summary written`));
  }

  // QA-dimension gate (a11y/perf/visual), independent of pass/fail.
  const gateFailures = qaGateFailures(reports, gates);
  if (gateFailures.length) for (const f of gateFailures) log(c.red(`  ✗ QA gate: ${f}`));

  // Triage gate: when set, the build's pass/fail is decided by triage category
  // instead of raw verdict — so CI can fail only on real product defects and
  // let environment-class outcomes (CAPTCHA, staging down) stay non-blocking.
  const triageGate = parseTriageCategories(flagValue(args, "--fail-on-triage"));
  const triageFailures = triageGateFailures(reports, triageGate);
  if (triageFailures.length) for (const f of triageFailures) log(c.red(`  ✗ Triage gate: ${f}`));

  const notifyUrl =
    flagValue(args, "--notify") ?? process.env.SENTINEL_SLACK_WEBHOOK ?? process.env.SENTINEL_WEBHOOK_URL;
  if (notifyUrl) {
    const res = await notifySuite(notifyUrl, name, reports, { timestamp: new Date().toISOString() });
    log(res.sent ? c.dim(`Notified ${new URL(notifyUrl).host}`) : c.yellow(`Notify failed: ${res.error}`));
  }

  if (triageGate.length) {
    // Triage gate provided -> it owns the pass/fail decision (QA gate still applies).
    process.exitCode = triageFailures.length || gateFailures.length ? 1 : 0;
  } else {
    process.exitCode = s.fail > 0 || gateFailures.length ? 1 : s.inconclusive > 0 ? 2 : 0;
  }
}

/** Quick one-off run from flags — no YAML needed. `sentinel try <url> --task …` */
async function tryCommand(args: string[]): Promise<void> {
  const built = buildInlineSpec({
    url: args.find((a) => !a.startsWith("--")),
    task: flagValue(args, "--task"),
    intent: flagValue(args, "--intent"),
    name: flagValue(args, "--name"),
    user: flagValue(args, "--user"),
    pass: flagValue(args, "--pass"),
    a11y: args.includes("--a11y"),
    viewport: flagValue(args, "--viewport"),
    expectText: collectFlags(args, "--expect-text"),
    forbidText: collectFlags(args, "--forbid-text"),
    expectUrl: collectFlags(args, "--expect-url"),
    forbidUrl: collectFlags(args, "--forbid-url"),
  });
  if (!built.ok) {
    console.error(
      c.red('Usage: sentinel try <url> --task "..." [--intent "..."] [--user U --pass P] [--a11y] [--expect-text "..."] [--forbid-text "..."] [--expect-url "..."] [--forbid-url "..."] [--headed] [--video] [--json]')
    );
    for (const e of built.errors) console.error(c.red(`  - ${e}`));
    process.exit(2);
  }
  const json = args.includes("--json");
  const headed = args.includes("--headed");
  const video = args.includes("--video");
  const maxIdx = args.indexOf("--max-steps");
  const maxSteps = maxIdx >= 0 ? Number(args[maxIdx + 1]) : undefined;
  const log = (s: string) => (json ? process.stderr.write(s + "\n") : console.log(s));

  log(c.cyan(`\n▶ try: ${String(built.spec!.task)}`));
  try {
    const report = await runSpec(built.spec!, {
      config: { headed: headed || undefined, maxSteps, video: video || undefined },
      onPhase: (p) => {
        if (!json) process.stdout.write(c.dim(`  · ${p}…\n`));
      },
      onStep: (s) => {
        if (!json) process.stdout.write(c.dim(`    [${s.index + 1}] ${s.call.name} — ${s.result.summary}\n`));
      },
    });
    await reportRun(report); // → Sentinel Cloud, if configured (no-op otherwise)
    if (json) process.stdout.write(JSON.stringify(toJsonReport(report), null, 2) + "\n");
    else printVerdict(report);
    process.exitCode =
      report.verdict.decision === "fail" ? 1 : report.verdict.decision === "inconclusive" ? 2 : 0;
  } catch (err) {
    console.error(c.red(`  ✗ ${(err as Error).message}`));
    process.exitCode = 2;
  }
}

async function initCommand(args: string[]): Promise<void> {
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error(c.red("Usage: sentinel init <url> [--out file.yaml] [--name NAME] [--draft] [--count N]"));
    process.exit(2);
  }
  const out = flagValue(args, "--out");
  const name = flagValue(args, "--name");
  const draft = args.includes("--draft");
  const count = Number(flagValue(args, "--count")) || 3;
  console.log(c.cyan(`\n▶ profiling ${url} …`));

  const session = new BrowserSession({
    headed: false,
    actionTimeoutMs: 15_000,
    artifactsDir: os.tmpdir(),
  });
  let yaml: string;
  let kind = "starter spec";
  try {
    await session.start();
    await session.goto(url);
    const profile = await profilePage(session);
    console.log(
      c.dim(
        `  detected: ${profile.headings.length} headings, ${profile.forms.length} form(s)` +
          `${profile.hasLogin ? ", login form" : ""}, ${profile.primaryActions.length} actions`
      )
    );
    if (draft) {
      // LLM drafting needs a key; fall back to the heuristic scaffold if absent.
      try {
        const cfg = loadConfig();
        const llm = new LlmClient(cfg.apiKey, cfg.model, new UsageMeter());
        console.log(c.dim(`  drafting ${count} test case(s) with ${cfg.model} …`));
        const cases = await draftSpecs(llm, profile, { count });
        yaml = draftedSuite(profile, cases, { name }).yaml;
        kind = `drafted suite (${cases.length} cases)`;
      } catch (err) {
        console.log(c.yellow(`  --draft needs ANTHROPIC_API_KEY (${(err as Error).message}); using heuristic scaffold instead.`));
        yaml = scaffoldSpec(profile, { name }).yaml;
      }
    } else {
      yaml = scaffoldSpec(profile, { name }).yaml;
    }
  } finally {
    await session.close();
  }

  if (out) {
    fs.writeFileSync(out, yaml);
    console.log(c.green(`\nWrote ${kind} → ${out}`));
    const verb = kind.startsWith("drafted") ? "suite" : "run";
    console.log(c.dim("Review, then: ") + `sentinel ${verb} ${out}`);
  } else {
    console.log("\n" + yaml);
  }
}

/** Is this file a suite (has a top-level `specs` array) vs a single spec? */
function isSuiteFile(file: string): boolean {
  try {
    const data = loadSpecFile(file) as { specs?: unknown };
    return Array.isArray(data.specs);
  } catch {
    return false;
  }
}

async function watchCommand(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || !fs.existsSync(file)) {
    console.error(c.red(`Usage: sentinel watch <spec-or-suite.(json|yaml)> [--headed]`));
    process.exit(2);
  }
  const headed = args.includes("--headed");
  console.log(c.cyan(`\n👁  watching ${file} — re-runs on change (Ctrl+C to stop)`));

  const runOnce = async () => {
    const stamp = new Date().toLocaleTimeString();
    console.log(c.dim(`\n[${stamp}] change detected — running…`));
    const data = loadSpecFile(file);
    if (isSuiteFile(file)) {
      const reports = await runSuite(data, {
        config: { headed: headed || undefined },
        onSpecDone: (r) => printVerdict(r),
      });
      const s = summarize(reports);
      console.log(c.bold(`${s.pass}/${s.total} passed`));
    } else {
      const report = await runSpec(data, { config: { headed: headed || undefined } });
      printVerdict(report);
    }
  };

  const handle = watchAndRun({
    source: fileChangeSource([file]),
    run: runOnce,
    onError: (err) => console.error(c.red(`run error: ${(err as Error).message}`)),
  });
  process.on("SIGINT", () => {
    handle.stop();
    console.log(c.dim("\nstopped."));
    process.exit(0);
  });
  // Keep the process alive until interrupted.
  await new Promise<void>(() => {});
}

/** Expand args into a flat list of spec/suite files (directories are scanned). */
function collectSpecFiles(args: string[]): string[] {
  const files: string[] = [];
  for (const a of args.filter((x) => !x.startsWith("--"))) {
    if (!fs.existsSync(a)) {
      files.push(a); // surfaced as "not found" below
      continue;
    }
    if (fs.statSync(a).isDirectory()) {
      for (const f of fs.readdirSync(a))
        if (/\.(ya?ml|json)$/i.test(f)) files.push(path.join(a, f));
    } else {
      files.push(a);
    }
  }
  return files;
}

function validateCommand(args: string[]): void {
  const files = collectSpecFiles(args.length ? args : ["specs"]);
  if (!files.length) {
    console.error(c.red("No spec files found."));
    process.exit(2);
  }
  let bad = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.log(`${c.red("✗")} ${file} ${c.dim("— not found")}`);
      bad++;
      continue;
    }
    let data: unknown;
    try {
      data = loadSpecFile(file);
    } catch (err) {
      console.log(`${c.red("✗")} ${file} ${c.dim("— parse error: " + (err as Error).message)}`);
      bad++;
      continue;
    }
    const res = validateSpecData(data);
    if (res.ok) {
      console.log(`${c.green("✓")} ${file} ${c.dim(`(${res.kind})`)}`);
    } else {
      bad++;
      console.log(`${c.red("✗")} ${file} ${c.dim(`(${res.kind})`)}`);
      for (const e of res.errors) console.log(c.red(`    ${e}`));
    }
    // Unknown-key warnings surface typo'd fields that would silently do nothing.
    for (const w of res.warnings) console.log(c.yellow(`    ⚠ ${w}`));
  }
  console.log(
    bad === 0
      ? c.bold(c.green(`\nAll ${files.length} file(s) valid.`))
      : c.bold(c.red(`\n${bad} of ${files.length} file(s) invalid.`))
  );
  process.exitCode = bad === 0 ? 0 : 1;
}

function approveCommand(args: string[]): void {
  const dir = flagValue(args, "--dir") ?? "runs";
  const all = args.includes("--all");
  const runArg = args.find((a) => !a.startsWith("--") && a !== dir);

  if (runArg) {
    const r = approveRun(runArg);
    if (!r) {
      console.error(c.red(`No promotable visual diff in ${runArg} (need a 'diff' run with visual-current.png).`));
      process.exitCode = 1;
      return;
    }
    console.log(c.green(`✓ baseline updated: ${r.title}`) + c.dim(`  → ${r.to}`));
    return;
  }

  const pending = findApprovals(dir);
  if (!pending.length) {
    console.log(c.dim("No pending visual diffs to approve."));
    return;
  }
  if (!all) {
    console.log(c.bold(`${pending.length} run(s) with a visual diff:`));
    for (const p of pending)
      console.log(`  ${c.yellow("▲")} ${p.title} ${c.dim(`(${(p.diffRatio * 100).toFixed(2)}%)  ${p.runDir}`)}`);
    console.log(c.dim("\nRe-run with --all to promote all, or pass a single run dir."));
    return;
  }
  for (const p of pending) {
    approveRun(p.runDir);
    console.log(c.green(`✓ ${p.title}`) + c.dim(`  → ${p.baselinePath}`));
  }
  console.log(c.bold(`\nPromoted ${pending.length} baseline(s).`));
}

async function doctorCommand(): Promise<void> {
  // Gather the real environment snapshot, then run the pure checks.
  let browserPath: string | null = null;
  try {
    const p = chromium.executablePath();
    browserPath = p && fs.existsSync(p) ? p : null;
  } catch {
    browserPath = null;
  }

  let runsWritable = true;
  try {
    fs.mkdirSync("runs", { recursive: true });
    fs.accessSync("runs", fs.constants.W_OK);
  } catch {
    runsWritable = false;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const ping = apiKey
    ? async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
          // Any HTTP response (even 401) means the API is reachable.
          const res = await fetch("https://api.anthropic.com/v1/models", {
            method: "GET",
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            signal: ctrl.signal,
          });
          return res.status > 0;
        } finally {
          clearTimeout(timer);
        }
      }
    : undefined;

  // The real "will Chromium run on this box?" test — launch and close it.
  const launch = async () => {
    try {
      const b = await chromium.launch({ headless: true });
      await b.close();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // Probe each configured model with a tiny real request — the only way to learn
  // the key is 429-capped or unauthorized for THAT model before a run does.
  const cfg = configSummary();
  const models = [...new Set([cfg.model, cfg.judgeModel])];
  const probeModel = apiKey
    ? async (model: string) => {
        try {
          const client = new Anthropic({ apiKey });
          await client.messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
          return { ok: true };
        } catch (err) {
          const status = (err as { status?: number })?.status;
          return { ok: false, status, error: err instanceof Error ? err.message : String(err) };
        }
      }
    : undefined;

  console.log(c.cyan("\nSentinel doctor\n"));
  const checks = await runDoctor({
    nodeVersion: process.version,
    apiKey,
    browserPath,
    runsWritable,
    ping,
    launch,
    models,
    probeModel,
    configFile: inspectConfigFile(),
  });
  for (const ch of checks) {
    const mark = ch.status === "ok" ? c.green("✓") : ch.status === "warn" ? c.yellow("⚠") : c.red("✗");
    console.log(`  ${mark} ${c.bold(ch.name)} ${c.dim("— " + ch.detail)}`);
  }
  // Show the resolved (non-secret) config so the user can confirm env /
  // sentinel.config.json took effect — which model, which output dirs.
  console.log(c.dim("\nResolved config:"));
  for (const [k, v] of [
    ["model", cfg.model],
    ["judgeModel", cfg.judgeModel],
    ["maxSteps", String(cfg.maxSteps)],
    ["runsDir", cfg.runsDir],
    ["baselinesDir", cfg.baselinesDir],
  ] as const) {
    console.log(c.dim(`  ${k.padEnd(13)} ${v}`));
  }

  const s = summarizeDoctor(checks);
  console.log(
    `\n${s.fail ? c.red(`${s.fail} failed`) : c.green("all critical checks passed")}` +
      c.dim(`  (${s.ok} ok, ${s.warn} warnings)`)
  );
  process.exitCode = doctorExitCode(checks);
}

async function serveCommand(args: string[]): Promise<void> {
  const port = Number(flagValue(args, "--port")) || 3100;
  const server = createServer({ port });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(c.cyan(`\n▶ Sentinel dashboard running`));
  console.log(`  Open ${c.bold(`http://localhost:${port}`)} in your browser.`);
  console.log(c.dim(`  Enter a URL + task, hit Run, and watch the agent's events stream live.`));
  console.log(c.dim(`  Needs ANTHROPIC_API_KEY set (same as 'run'). Ctrl-C to stop.`));
  // Keep the process alive until the server closes — returning here would let
  // the entrypoint's `process.exit()` kill the server immediately. Ctrl-C
  // closes it gracefully and resolves.
  process.on("SIGINT", () => {
    console.log(c.dim("\nShutting down…"));
    server.close(() => process.exit(0));
  });
  await new Promise<void>((resolve) => server.on("close", resolve));
}

async function mcpCommand(): Promise<void> {
  // stdout is the MCP transport — every log MUST go to stderr or it corrupts
  // the protocol stream. Keep the process alive on stdin (the client owns it).
  console.error(c.cyan("▶ Sentinel MCP server on stdio") + c.dim("  (exposes sentinel_qa to your coding agent)"));
  await startMcpServer();
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") usage();

  if (argv[0] === "mcp") {
    await mcpCommand();
    return;
  }

  if (argv[0] === "suite") {
    await suiteCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "init") {
    await initCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "try") {
    await tryCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "watch") {
    await watchCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "serve") {
    await serveCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "doctor") {
    await doctorCommand();
    return;
  }
  if (argv[0] === "approve") {
    approveCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "validate") {
    validateCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "open") {
    const dir = flagValue(argv.slice(1), "--dir") ?? "runs";
    const report = findLatestReport(dir);
    if (!report) {
      console.error(c.red(`No report found under ${dir}/. Run a spec or suite first.`));
      process.exitCode = 1;
      return;
    }
    console.log(c.dim(`opening ${path.relative(process.cwd(), report)}`));
    spawn(openerFor(process.platform), [report], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (argv[0] === "history") {
    const a = argv.slice(1);
    const dir = flagValue(a, "--dir") ?? "runs";
    const out = flagValue(a, "--out") ?? path.join(dir, "index.html");
    const failOnRegression = a.includes("--fail-on-regression");
    const failOnQaDrift = a.includes("--fail-on-qa-drift");
    const notifyUrl = flagValue(a, "--notify") ?? process.env.SENTINEL_SLACK_WEBHOOK ?? process.env.SENTINEL_WEBHOOK_URL;
    const { path: p, history } = writeHistory(dir, out);
    const { runs, regressed, fixed, qaDrifted } = history.totals;
    const reg = regressed ? c.red(`  ·  ${regressed} regressed`) : "";
    const fix = fixed ? c.green(`  ·  ${fixed} fixed`) : "";
    const drift = qaDrifted ? c.yellow(`  ·  ${qaDrifted} QA-drifted`) : "";
    console.log(c.bold(`Aggregated ${runs} run(s)`) + reg + fix + drift + c.dim(`  ·  ${path.relative(process.cwd(), p)}`));
    if (regressed) {
      const list = history.specs.filter((s) => s.trend === "regressed");
      for (const s of list) console.log(c.red(`  ▼ regressed: ${s.title}`));
      if (notifyUrl) {
        const res = await notifyRegression(notifyUrl, list);
        console.log(res.sent ? c.dim(`Alerted ${new URL(notifyUrl).host}`) : c.yellow(`Notify failed: ${res.error}`));
      }
    }
    if (qaDrifted) {
      for (const s of history.specs.filter((s) => s.qaDrift))
        console.log(c.yellow(`  ⚠ QA drift: ${s.title} (${s.lastQaIssues} issue(s))`));
    }
    if ((failOnRegression && regressed > 0) || (failOnQaDrift && qaDrifted > 0)) process.exitCode = 1;
    return;
  }

  const cmd = argv[0] === "run" ? argv.slice(1) : argv;
  const headed = cmd.includes("--headed");
  const maxIdx = cmd.indexOf("--max-steps");
  const maxSteps = maxIdx >= 0 ? Number(cmd[maxIdx + 1]) : undefined;
  const junitIdx = cmd.indexOf("--junit");
  const junitPath = junitIdx >= 0 ? cmd[junitIdx + 1] : undefined;
  const storageState = flagValue(cmd, "--storage-state");
  const saveStorageStateTo = flagValue(cmd, "--save-state");
  const retries = Number(flagValue(cmd, "--retries")) || 0;
  const json = cmd.includes("--json");
  const video = cmd.includes("--video");
  const vpOverride = flagValue(cmd, "--viewport");
  const consumed = new Set([
    String(maxSteps),
    junitPath,
    storageState,
    saveStorageStateTo,
    String(retries),
    vpOverride,
    flagValue(cmd, "--fail-on"),
  ]);
  const files = cmd.filter((a) => !a.startsWith("--") && !consumed.has(a));

  if (!files.length) {
    console.error(c.red("No spec files given."));
    usage();
  }

  // In --json mode keep stdout pure JSON; progress/logs go to stderr.
  const log = (s: string) => (json ? process.stderr.write(s + "\n") : console.log(s));

  const reports: RunReport[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(c.red(`Spec not found: ${file}`));
      process.exitCode = 2;
      continue;
    }
    log(c.cyan(`\n▶ ${file}`));
    let phase = "";
    try {
      const loaded = loadSpecFile(file) as Record<string, unknown>;
      if (vpOverride) loaded.viewport = vpOverride;
      // A spec may declare data-driven `cases` — run it once per case.
      const cases = expandCases(loaded);
      for (const { spec, vars } of cases) {
        if (cases.length > 1) log(c.dim(`  ◆ case: ${spec.title}`));
        const { report } = await withRetry(
          (attempt) => {
            if (attempt > 1) log(c.yellow(`  ↻ retry ${attempt - 1}/${retries}`));
            return runSpec(spec, {
              config: { headed: headed || undefined, maxSteps, video: video || undefined },
              storageState,
              saveStorageStateTo,
              vars,
              onPhase: (p) => {
                phase = p;
                if (!json) process.stdout.write(c.dim(`  · ${p}…\n`));
              },
              onStep: (s) => {
                if (!json)
                  process.stdout.write(
                    c.dim(`    [${s.index + 1}] ${s.call.name} — ${s.result.summary}\n`)
                  );
              },
            });
          },
          retries
        );
        reports.push(report);
        await reportRun(report); // → Sentinel Cloud, if configured (no-op otherwise)
        if (!json) printVerdict(report);
      }
    } catch (err) {
      console.error(c.red(`  ✗ error during ${phase}: ${(err as Error).message}`));
      process.exitCode = 2;
    }
  }

  // Aggregate exit code: fail dominates, then inconclusive.
  const decisions = reports.map((r) => r.verdict.decision);
  if (decisions.includes("fail")) process.exitCode = 1;
  else if (decisions.includes("inconclusive") && !process.exitCode) process.exitCode = 2;

  // QA-dimension gate: hard-fail on selected breaches regardless of the verdict.
  const gates = parseGates(flagValue(cmd, "--fail-on"));
  const gateFailures = qaGateFailures(reports, gates);
  if (gateFailures.length) {
    for (const f of gateFailures) log(c.red(`  ✗ QA gate: ${f}`));
    process.exitCode = 1;
  }

  if (junitPath && reports.length) {
    fs.writeFileSync(junitPath, toJUnit(reports, "sentinel", gates));
    log(c.dim(`\nJUnit XML → ${junitPath}`));
  }

  if (reports.length && (cmd.includes("--github") || isGithubActions(process.env))) {
    emitGithub({ reports, suiteName: "Sentinel", env: process.env });
  }

  if (json) {
    const docs = reports.map((r) => toJsonReport(r));
    process.stdout.write(JSON.stringify(files.length === 1 ? docs[0] ?? null : docs, null, 2) + "\n");
  } else if (reports.length > 1) {
    const pass = decisions.filter((d) => d === "pass").length;
    console.log(c.bold(`\n${pass}/${reports.length} passed`));
  }
}

main()
  .then(() => {
    // Force exit so a lingering keep-alive fetch connection (webhook notify)
    // can't keep the process alive after the command has finished. `watch`
    // never resolves, so it is unaffected.
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
