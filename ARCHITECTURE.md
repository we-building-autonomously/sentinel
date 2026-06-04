# Sentinel — Architecture

Sentinel is a **browser-native QA agent**. Where a coding agent is "code-native" (it edits files), Sentinel is "browser-native": it drives a real Chromium like a human tester and renders a pass/fail verdict with commentary. This document maps the codebase, the data flow, and the design decisions behind it.

## The one-paragraph mental model

A `TestSpec` (task + intent + app metadata) goes in. A **Planner** turns the intent into observable checkpoints. An **Agent loop** drives the browser one action at a time — each step it *perceives* (a ref-addressed snapshot of interactable elements, with a screenshot fallback for canvas apps), *thinks* (Claude tool-use), and *acts* (Playwright). A **Judge** (a separate, stronger model) reviews the whole trace — actions, console/network errors, auto-handled dialogs — and renders a strict verdict against the checkpoints. A **Reporter** emits the verdict as redacted JSON / Markdown / HTML, an interactive replay, and JUnit.

```
TestSpec ─▶ navigate (fail-fast if unreachable) ─▶ Planner ─▶ Agent loop ─▶ Judge ─▶ Reporter
              │                                       │           │            │          │
              └─ unreachable → inconclusive,          checkpoints  perceive→    strict     json/md/html
                 zero LLM calls                                    think→act     verdict    trace/junit
```

## Why ref-addressed DOM, not pixels

The core perception decision: every step, an injected script (`src/browser/indexer.ts`) walks the DOM, tags each **visible, interactable** element with `data-sn-idx`, and emits a compact listing (`[12] <button> "Sign in" role=button`). The model picks elements by integer index; the executor resolves the index back to a Playwright locator in the owning frame. This is far more reliable and cheaper than screenshot/coordinate clicking, and it grounds the model in the real accessibility tree. Coordinate-based vision (`click_at`/`type_text` + a screenshot) is a *fallback*, engaged only when the DOM is too sparse to drive (canvas apps) — see `shouldUseVision`.

## Module map

```
src/
  types.ts            Domain contract: TestSpec, Plan, Step, Verdict, RunReport, Diagnostic, DialogRecord
  config.ts           Env/config loading (models, timeouts, budgets)
  runner.ts           Orchestrates one spec: navigate → plan → loop → judge → report
  suite.ts            Suites: shared defaults, login-once, parallel exec, retry, filtering
  pool.ts             Bounded concurrency primitive (order-preserving)
  retry.ts            withRetry — flaky detection (fail-then-pass)
  filter.ts           Tag / grep spec selection
  watch.ts            Debounced file-watch re-run (Debouncer + watchAndRun)
  draft.ts            LLM-drafted specs from a page profile (init --draft)
  scaffold.ts         Heuristic spec scaffold from a page profile (init)
  doctor.ts           Preflight environment checks
  usage.ts            Token + cost accounting (UsageMeter, per-tier pricing)
  util.ts             slugify / trimLine / errMsg

  llm/anthropic.ts    Resilient Claude client: retries+backoff, prompt caching,
                      structured-output (forced tool), usage metering

  browser/
    session.ts        Playwright wrapper: launch, navigate(+status/retry), frames,
                      screenshots, storageState, dialogs, popups, diagnostics
    indexer.ts        Injected DOM walker → ref-addressed snapshot; canvas detection;
                      in-viewport-prioritized display capping
    tools.ts          Tool defs + executor (navigate/click/type/select/hover/go_back/
                      press/scroll/wait_for/extract/click_at/type_text/done)
    diagnostics.ts    Console/pageerror/4xx-5xx collector (dedup, noise filter, cap)
    profile.ts        Structural page profile (headings/forms/actions/login) for init

  agent/
    prompts.ts        System prompts for planner / actor / judge
    planner.ts        intent → observable checkpoints (structured)
    loop.ts           perceive→think→act loop; sliding observation window; vision;
                      one-action-per-turn; guard; dialog/tab reconciliation
    guard.ts          LoopGuard: time budget + repeat/stuck detection
    judge.ts          Trace + diagnostics + dialogs → strict verdict (structured)

  report/
    reporter.ts       report.json / .md / .html + trace.html
    redact.ts         Secret masking (shared by all outputs; never mutates input)
    trace-viewer.ts   Interactive step-by-step replay (screenshots, timing, vision)
    junit.ts          JUnit XML (+ cost/flaky properties)
    suite-report.ts   Aggregate suite dashboard
    history.ts        Cross-run trend dashboard (pass-rate/flaky/cost sparklines)
    json-report.ts    Stable machine-readable contract for --json

  cli.ts              doctor · init · watch · run · suite · history
  index.ts            Public library API
  testing/scripted-llm.ts   Deterministic LLM double for integration tests
```

## Data flow, in detail

1. **Navigate first.** `runner.ts` starts the browser and navigates *before* planning. If the app is unreachable (DNS/refused/timeout, retried once), it short-circuits to an `inconclusive` verdict with **zero LLM calls** — no spend on a dead target.
2. **Plan.** `planner.ts` asks the actor model for a goal restatement and 2–5 *observable* checkpoints.
3. **Loop.** `loop.ts` seeds the conversation with the goal, app context (credentials, redacted on disk), and the first observation. Each turn:
   - Pre-LLM **time-budget** check (`guard.ts`) so we never pay for a call past budget.
   - The model returns tool calls; **only the first is honored** (later ones address a now-stale DOM — they get a skip result).
   - The **guard** registers the action against a page signature → stops on repeat/stuck.
   - The executor runs the action (`tools.ts`); its wall-clock duration is recorded.
   - The session reconciles **new tabs** and drains **auto-handled dialogs**, then a fresh observation (with a screenshot in vision mode) is appended.
   - A **sliding window** keeps only the last few full observations (and only the latest screenshot) to bound tokens.
4. **Judge.** `judge.ts` (a separate, typically stronger model) sees the task, checkpoints, the full action trace, captured console/network errors, and auto-handled dialogs — and returns a strict verdict mapping each checkpoint to met/unmet/unknown with evidence.
5. **Report.** Everything is redacted, then written as JSON/MD/HTML + an interactive `trace.html`. Suites add an aggregate dashboard, JUnit, and optional Slack/webhook notification.

## Key design decisions

- **Two models, two jobs.** A cheaper actor drives; a stricter judge adjudicates. Absence of evidence is never success.
- **Structured output via forced tool calls.** Planner/judge/draft/extract use `tool_choice` to guarantee schema-valid output, validated at the tool layer.
- **Prompt caching.** The large, stable system prompt + tool defs are cached across the loop's many turns; cache-read tokens are priced near-free in `usage.ts`.
- **Resilience is first-class.** iframes (frame-aware indexing), canvas (vision fallback), dialogs/popups (auto-handled + recorded), stale refs (fail-fast re-observe), large pages (in-viewport capping), unreachable apps (short-circuit), and runaway loops (time/repeat/stuck guard) are all handled explicitly.
- **Secrets never hit disk.** Credentials are passed to the model at runtime but `redact.ts` masks them in *every* artifact (file or `--json` stdout), without mutating the caller's object.
- **Everything is accountable.** The verdict is grounded in actions, errors, *and* bypassed dialogs; the report shows token cost and per-step timing.

## Testing strategy

- **Pure logic** (pricing, redaction, debounce, retry/flaky, filtering, history, JSON contract, guard, capping, scaffolding/drafting) is unit-tested deterministically — no browser, no key.
- **Browser behaviors** that can't be cheaply faked (indexing, iframe clicks, dialogs, popups, vision, hover/back, large-page capping, storageState) are validated by `scripts/probe-*.mjs` against real Chromium — still no API key.
- **The full pipeline** is covered by `runner.integration.test.ts`: a real Chromium driven by a **scripted LLM** exercises navigate → plan → loop (real tool execution) → judge → report, including the unreachable short-circuit and one-action-per-turn — deterministically and without a key.

The only thing that requires a real `ANTHROPIC_API_KEY` is a live model run; the orchestration around it is proven by the above. `sentinel doctor` reports exactly what's present.

## Extending Sentinel

- **A new agent capability** → add a tool def + executor method in `browser/tools.ts`, mention it in `agent/prompts.ts`, and add a probe.
- **A new output format** → add a serializer in `report/`, wire it into `writeReports` or the CLI, and export it from `index.ts`.
- **A new perception signal** → extend the injected walker in `browser/indexer.ts` (it must stay self-contained — it's serialized into the page).
