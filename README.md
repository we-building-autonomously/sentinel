# Sentinel

[![npm](https://img.shields.io/npm/v/@sentinel/qa)](https://www.npmjs.com/package/@sentinel/qa)
[![CI](https://github.com/we-building-autonomously/sentinel/actions/workflows/sentinel.yml/badge.svg)](https://github.com/we-building-autonomously/sentinel/actions/workflows/sentinel.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A browser-native testing harness.** Coding agents are great at *writing* software and bad at *testing* it. Sentinel is the missing half: you hand it a task, the user intent behind it, and the app's metadata (URL, login) — and it drives a real browser like a real user, then returns a **pass / fail verdict with commentary**, exactly like a QA engineer signing off on a manual test.

It is to QA what a coding agent is to code: same loop (perceive → think → act → verify), but **browser-native** instead of code-native.

```
TestSpec (task + intent + app metadata)
   │
   ├─▶ Planner   turns intent into observable checkpoints
   ├─▶ Agent     drives Chromium via ref-addressed DOM tools (Claude tool-use loop)
   ├─▶ Judge     adjudicates the trace strictly against the checkpoints
   └─▶ Reporter  JSON + Markdown + self-contained HTML report, screenshots, Playwright trace
```

## Why ref-addressed DOM, not pixels

Sentinel re-indexes the page every step: an injected script tags every *visible, interactable* element with `data-sn-idx` and emits a compact, token-efficient listing (`[12] <button> "Sign in" role=button`). The model addresses elements by index; the executor resolves the index back to a Playwright locator. This is dramatically more reliable and cheaper than screenshot/coordinate clicking, and it grounds the model in the real accessibility tree.

## Install

```bash
npm install -g @sentinel/qa
npx playwright install chromium      # one-time: download the browser it drives
export ANTHROPIC_API_KEY=sk-ant-...  # the model that drives the browser
```

That puts the `sentinel` command on your PATH. Prefer not to install globally? `npx @sentinel/qa <command>` works too.

<details>
<summary>From source (for contributors)</summary>

```bash
git clone https://github.com/we-building-autonomously/sentinel.git
cd sentinel
npm install
npx playwright install chromium
npm run build && npm link
```
</details>

## Preflight

```bash
sentinel doctor
```

Checks Node version, `ANTHROPIC_API_KEY`, the Chromium install, output-dir writability, and (if a key is set) API reachability. Exits non-zero only on a hard failure.

## Run

```bash
npm run build
node dist/cli.js run specs/example.todomvc.json
# or, without building:
npm run dev -- run specs/example.search.yaml --headed
```

Exit code: `0` pass · `1` fail · `2` inconclusive/error — so it drops straight into CI.

Add `--fail-on <gates>` (on `run` or `suite`) to hard-fail the build on a QA-dimension breach **independent of the functional verdict**, comma-separated from: `a11y` · `a11y-critical` (only critical/serious) · `perf` · `visual` · `layout` (horizontal overflow) · `security` (a high/medium missing-header/cookie finding) · `errors` (any uncaught JS exception / console error / 5xx) · `requests` · `text` · `url` (the final URL lacks a required substring or has a forbidden one) · `state` (a cookie/storage entry missing, wrong, or not cleared) · `downloads` · `clipboard` · `toast` (an unmet assertion of the corresponding kind). E.g. `--fail-on visual,errors,layout` reds the build on a visual regression, any runtime error, or a responsive-layout overflow. A gate breach also turns its JUnit testcase into a `<failure>`, so CI dashboards match the exit code.

On a **suite**, `--fail-on-triage product-defect,blocked,…` (or `actionable`) instead decides pass/fail by *triage category*, so CI fails only on genuine product defects and stays green when a run was merely blocked by a CAPTCHA or a down staging box.

**GitHub Actions** is first-class: inside a workflow (auto-detected via `GITHUB_ACTIONS`, or forced with `--github`) Sentinel writes a rendered results table to the **job summary** (`$GITHUB_STEP_SUMMARY`) and emits **workflow annotations** — `::error` for product defects, `::warning` for blocked/inconclusive runs — so failures show up inline on the run and the PR. Pairs with `--shard` and `--junit` for a full CI setup.

Add `--json` to `run` or `suite` for a stable, redacted machine-readable result on stdout (logs go to stderr), e.g. `sentinel run spec.yaml --json | jq .decision`. Add `--video` to record the run (a `.webm` embedded in the HTML report).

### Quick one-off (no spec file)

For an ad-hoc check, skip the YAML entirely:

```bash
sentinel try https://app.example.com --task "log in and open settings" \
  --intent "the settings page is shown" --user me@x.com --pass '…' \
  --expect-text "Settings" --forbid-text "undefined"
```

`--expect-text` / `--forbid-text` (repeatable) assert page content (see below); `--a11y`, `--viewport`, `--headed`, `--video`, `--json` all work too.

## Project config

Drop a `sentinel.config.json` in the repo root for project-wide defaults — `model`, `judgeModel`, `maxSteps`, `runsDir`, `baselinesDir`, `headed`, `video`, timeouts. Precedence is **CLI flag → environment → config file → built-in default**, and the API key is never read from the file (env / `.env` only):

```json
{ "model": "claude-sonnet-4-6", "maxSteps": 30, "runsDir": "artifacts", "baselinesDir": ".sentinel/baselines" }
```

## Spec format

```jsonc
{
  "title": "User can sign up",
  "task": "Create a new account and reach the dashboard",
  "intent": "After signup the user lands on an authenticated dashboard showing their email",
  "app": {
    "url": "https://app.example.com",
    "auth": { "username": "qa@example.com", "password": "..." },  // redacted in reports
    "notes": "Signup link is in the top-right."
  },
  "criteria": ["Dashboard shows the user's email"],  // optional; else derived from intent
  "maxSteps": 40
}
```

YAML specs work too (see `specs/`). Credentials are passed to the agent at runtime but **redacted from every artifact written to disk**.

### Templating

Any string in a spec can use `{{token}}` placeholders, resolved once per run:
`{{randomEmail}}`, `{{randomString}}`, `{{uuid}}`, `{{timestamp}}`, and `{{env.NAME}}`. So a signup test gets a *fresh* email each run (no "email already taken" flakes) and one spec can target any environment via `{{env.APP_URL}}`. See `specs/example.signup.yaml`.

### Visual regression

Set `"visual": true` (or `{ "maxDiffRatio": 0.02 }`) on a spec to compare the final page against a saved baseline screenshot. The first run captures the baseline under `baselines/<spec-id>.png` (commit it); later runs pixel-diff against it and, on a regression, emit a highlighted `visual-diff.png` in the run dir (embedded in the HTML report). A size change counts as a regression.

When a diff is intentional (a redesign), promote the new screenshot to the baseline:

```bash
sentinel approve              # list runs with a pending visual diff
sentinel approve --all        # promote them all to baselines/
sentinel approve runs/<dir>   # promote one run
```

### Performance budget

Every run captures the initial page's load metrics (TTFB, FCP, DOMContentLoaded, load, transfer size) and shows them in the report. Add a `perfBudget` (ms) to a spec to make a slow load a finding — `{ loadMs: 5000, fcpMs: 2500 }` — exceedances are reported and the judge treats them as a fail-worthy issue.

### Accessibility audit

Set `"a11y": true` on a spec to run an [axe-core](https://github.com/dequelabs/axe-core) accessibility audit on the final page. Violations (sorted by impact: critical → minor) appear in the report and `--json`, and are passed to the judge as issues. See `specs/example.todomvc.json`.

### Content & network assertions

Beyond the LLM verdict, a spec can declare **objective, deterministic** checks:

- `"expectText": ["Order confirmed"]` / `"forbidText": ["undefined", "NaN", "{{name}}"]` — exact text that must / must not appear on the final page. `forbidText` catches a whole class of bugs the judge can gloss over: unrendered template variables, stringified `undefined`/`NaN`/`[object Object]`, leaked error strings.
- `"expectUrl": ["/dashboard"]` / `"forbidUrl": ["/login", "error="]` — substrings the **final page URL** must / must not contain. Pins the redirect objectively: did login land on the dashboard and actually leave `/login`? Did checkout reach `/order/123` with no `error=` query?
- `"expectRequests": [{ "url": "/api/save", "method": "POST", "status": 200 }]` — the app must (or, with `"min": 0`, must **not**) make a matching HTTP call. Catches the optimistic-UI bug where the screen says "Saved" but nothing was actually sent.

`expectRequests` can also assert the payload with `"bodyIncludes": "sku-"` (a substring the POST body must contain). More deterministic checks:

- `"expectDownloads": [{ "filename": "report-*.csv", "contentIncludes": "sku-1" }]` — an export downloaded whose name/content matches (verifies the file, not just that one arrived).
- `"expectClipboard": "cwz_…"` — a "Copy" button copied this substring (captured via `navigator.clipboard.writeText`).
- `"expectToast": "Saved"` — a toast/status (`aria-live`) message appeared — captured even if it vanished in a second, so it's not a race.
- `"expectState": [{ "scope": "cookie", "key": "cookie_consent", "value": "accepted" }, { "scope": "localStorage", "key": "cart", "absent": true }]` — assert what the app **persisted** in the browser after the run (cookies / `localStorage` / `sessionStorage`): a token was stored on login, consent set a cookie, the cart key was cleared on logout. `value` is a substring; `absent: true` requires the key be gone. This is state the LLM judge literally can't see.

All assertions feed the judge (an unmet one is strong fail evidence) **and** a matching deterministic `--fail-on` gate. See `specs/example.assertions.yaml` for a worked example.

Crucially, these assertions are **objective acceptance criteria, not just hints**: if the LLM judge returns `pass` while any declared assertion is unmet, the verdict is automatically reconciled down to `fail` (the same machine-correction that catches a `pass` left contradicting its own checkpoints). A falsely-passing test is the single most dangerous output a QA harness can emit, so objective truth always overrides the judge — the override is recorded in the verdict's issues with the confidence capped.

### Security audit & responsive layout

`"security": true` audits the main document's response headers (CSP, HSTS, X-Frame-Options, …) **and** session-cookie flags (HttpOnly/Secure/SameSite). Every run also flags **horizontal overflow** (content wider than the viewport — a responsive bug), shown in the report and gateable with `--fail-on layout`. Both are weighed by the judge only when the intent is about security / layout.

### Security-header audit

Set `"security": true` to audit the main document's response headers and flag missing defenses — Content-Security-Policy (high), `X-Content-Type-Options: nosniff` / X-Frame-Options (or CSP `frame-ancestors`) / HSTS-on-HTTPS (medium), Referrer-Policy + server/stack info leaks (low). Findings appear in the report and `--json`; `--fail-on security` reds the build on high/medium findings.

### File uploads

A spec's `uploads` lists file paths the test can attach: `"uploads": ["./fixtures/avatar.png"]`. When the flow clicks a file input, Sentinel feeds the file to the native chooser automatically (rotating through them for multi-step uploads, all of them for multi-select inputs). With no files configured, the chooser is cancelled cleanly — either way the agent never hangs on a native dialog.

### Network mocking

A spec's `mocks` stub matching requests so you can test states that are hard to trigger for real — an API `500`, an empty list, a slow/loading response. Each mock matches a URL glob (optionally a method) and fulfills with a `json`/`body` + `status` (+ `delayMs`). The agent is told which endpoints are stubbed so it judges the resulting state as intended. See `specs/example.error-state.yaml`.

### Protected staging environments

To test a preview/staging URL behind a gate, a spec's `app` can carry `headers` (e.g. a Vercel/Cloudflare bypass token), `httpCredentials` (HTTP basic auth), and/or `cookies` (a feature-flag or session cookie). All values are **redacted from every report**. See `specs/example.staging.yaml`.

### Viewports & devices

A spec's `viewport` (or `run --viewport …`) tests responsive/mobile layouts: a preset (`desktop` / `tablet` / `mobile`), a Playwright device name (`"iPhone 13"`), or `WIDTHxHEIGHT`. Mobile presets apply touch + device-scale + a mobile user-agent, and the agent is told it's on a narrow layout. See `specs/example.mobile.yaml`.

## Scaffolding a spec

Don't write specs from scratch — point Sentinel at a URL and it profiles the page (headings, forms, primary actions, login detection) and generates a grounded starter spec:

```bash
sentinel init https://app.example.com/login --out specs/login.yaml
```

It auto-fills the app name, tags (`auth` when a login form is found), an auth block, and a task grounded in the real form fields — leaving clearly-marked TODOs for you to refine. No API key needed.

With `--draft` (and an `ANTHROPIC_API_KEY`), the model writes **ready-to-run test cases** from the page profile instead of TODO stubs, emitted as a suite:

```bash
sentinel init https://app.example.com/login --draft --count 4 --out specs/login-suite.yaml
```

## Suites & login-once

Group many tests against one app and run them in parallel:

```bash
sentinel suite specs/example.suite.yaml --concurrency 3 --junit results.xml
```

A suite declares the app `url`/`auth` once under `defaults` (merged into every spec, spec-level wins) and can declare a `login` spec that runs **once**; its authenticated `storageState` (cookies + localStorage) is then reused by every other spec — no repeated logins, faster and less flaky (see `specs/example.authed-suite.yaml`). The suite writes an aggregate HTML dashboard linking each run.

**Data-driven cases.** Give a spec a `cases` list to run it once per row, with each row's fields exposed as `{{tokens}}` and `name` used for the `[case]` title suffix — one definition covers many inputs instead of N copy-pasted specs. Works in both `sentinel run spec.yaml` and inside a suite (and composes with the viewport matrix). See `specs/example.data-driven.yaml`:

```yaml
task: "Pay with card {{card}} and submit"
expectText: ["{{outcome}}"]
cases:
  - { name: visa,     card: "4111111111111111", outcome: "Order confirmed" }
  - { name: declined, card: "4000000000000002", outcome: "Payment declined" }
```

**Emulation** for theme / i18n / a11y testing: a spec can set `emulate: { colorScheme: dark, reducedMotion: reduce, locale: "fr-FR", timezoneId: "Asia/Tokyo" }` to drive the app in dark mode, with reduced motion, or under a given locale (affects `Intl` date/number/currency formatting and `navigator.language`) and timezone (affects displayed dates/times). The active emulation is also told to the agent so it expects the localized/dark UI. Pairs naturally with `visual` (dark-mode visual regression) and `expectText`/`expectState` (localized copy).

**Frozen clock** for deterministic date/time UI: `clock: { now: "2026-01-15T09:00:00Z" }` (ISO string or epoch ms) freezes the browser's `Date.now()`/`new Date()` to that instant on every page, so "today's date", relative timestamps ("2 hours ago"), countdowns and trial-expiry banners are reproducible — no more tests that pass today and fail next month. Timers still tick, so apps don't stall. The agent is told the frozen "now". Composes with `emulate.timezoneId`.

Add a **matrix** to run every spec across the **cartesian product** of axes — `matrix: { viewport: [desktop, mobile], colorScheme: [light, dark], locale: [en-US, fr-FR] }` runs each spec 8× (every combination), or set them on the CLI with `--viewports`, `--color-schemes`, `--locales`. Each variant sets the corresponding viewport / `emulate.colorScheme` / `emulate.locale` and appears as `Title [mobile · dark · fr-FR]` in the dashboard and history — so one spec covers responsive × theme × i18n in a single suite run.

**Sharding across CI workers.** For a large suite, split the work across parallel machines with `--shard i/n` (1-based, like Playwright/Jest): each worker runs a deterministic, balanced round-robin slice of the specs (matrix variants included), and login-once still runs on every worker so each has its own authenticated session. An empty shard exits 0 (a normal CI outcome). Each worker writes its own `--junit` file for the CI to merge.

```yaml
# .github matrix → 4 parallel jobs:
- run: sentinel suite specs/all.suite.yaml --shard ${{ matrix.i }}/4 --junit results-${{ matrix.i }}.xml
```

**Setup / teardown hooks** for state isolation — the biggest cure for flaky end-to-end tests. A spec can fire HTTP requests before the run (`setup`) and after it (`teardown`) to prepare and clean up its own data via an API, instead of depending on whatever state the app was left in:

```yaml
setup:    # reset/seed via API before the browser even starts; a failure blocks the run
  - { method: DELETE, url: "{{env.API}}/test/cart", headers: { Authorization: "Bearer {{env.TOKEN}}" } }
teardown: # best-effort cleanup afterwards
  - { method: POST, url: "{{env.API}}/test/reset" }
```

URLs and bodies are `{{template}}`-resolved (so they line up with per-case `cases` data), auth headers/bodies are redacted from reports, and a failed setup is triaged as `blocked` (the test couldn't run against a prepared state) rather than a product defect.

You can also capture/reuse auth manually on single runs:

```bash
sentinel run login.yaml --save-state auth.json     # capture once
sentinel run checkout.yaml --storage-state auth.json  # reuse
```

**Two-factor (TOTP) logins.** Give a spec a base32 authenticator secret with `"auth": { …, "totpSecret": "JBSWY3DPEHPK3PXP" }` and the agent gets a `get_totp` tool that generates the current 6-digit code on demand — so a 2FA-protected login completes instead of stalling at the code prompt (the secret is redacted from all reports; the ephemeral code is not stored).

## CI

A ready-to-use GitHub Actions workflow is in `.github/workflows/sentinel.yml` (build → unit tests → run suite → upload `runs/` + JUnit → surface results in the checks UI). For hermetic runs, `Dockerfile` bundles Chromium and all OS deps:

```bash
docker build -t sentinel .
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD/specs:/app/specs" sentinel suite specs/example.suite.yaml
```

## Watch mode

Iterate on a spec with instant feedback — re-runs whenever the file changes:

```bash
sentinel watch specs/login.yaml --headed
```

Bursts of edits are debounced, runs never overlap, and Ctrl+C stops cleanly. Works on single specs and suites.

## History / trend dashboard

Aggregate every past run into a quality trend view (pass-rate, flakiness, cost per spec, with a sparkline of recent results):

```bash
sentinel history            # writes runs/index.html
sentinel history --dir runs --out reports/trend.html
```

## Notifications

Post suite results to Slack or any webhook on completion:

```bash
sentinel suite specs/example.suite.yaml --notify https://hooks.slack.com/services/T/B/X
# or set SENTINEL_SLACK_WEBHOOK / SENTINEL_WEBHOOK_URL in the environment
```

Slack URLs get a Block Kit message (red/green headline, counts, cost, a **triage rollup** + per-dimension **QA rollup**, and only the failing/flaky specs called out — each tagged with its triage category); any other URL receives a structured JSON payload (`suite`, `ok`, `summary`, `costUsd`, `results[]`) you can route anywhere.

## Triage

Every run is classified into an actionable bucket — `passed` · `flaky-pass` · `product-defect` · `blocked-external` (CAPTCHA/2FA/email) · `blocked` · `app-unavailable` · `inconclusive` · `skipped` — so a red suite tells you *what to do* (a real bug vs. an environment blip), not just that something failed. It's surfaced per-run (report + `--json`), rolled up across a suite (dashboard + Slack), drives a triage-aware regression trend (an environment block never counts as a regression), maps to JUnit `<skipped>` for env blocks, and is gateable via `--fail-on-triage`.

## Programmatic use

```ts
import { runSpec } from "sentinel";
const report = await runSpec(spec);
if (report.verdict.decision !== "pass") process.exit(1);
```

## Use it from your coding agent (MCP + Claude Code plugin)

Coding agents write the code; Sentinel is the half that checks it actually works for a user. Sentinel exposes its QA loop over the **Model Context Protocol**, so any MCP-capable agent (Claude Code, Cursor, a custom harness) can call it as a tool and get back a structured verdict to self-correct against.

**MCP server** — runs over stdio:

```bash
sentinel mcp
```

It registers one tool, `sentinel_qa`, which takes `{ url, task, intent?, user?, pass?, expectText?, forbidText?, a11y? }`, drives a real browser, and returns a compact verdict: `decision` (pass/fail/inconclusive), `confidence`, per-checkpoint `met/unmet/unknown` with evidence, triage category, captured runtime errors, cost, and the report dir. Register it like any stdio MCP server:

```json
{
  "mcpServers": {
    "sentinel": { "command": "node", "args": ["/abs/path/sentinel/dist/cli.js", "mcp"] }
  }
}
```

**Claude Code plugin** — this repo is also a Claude Code plugin. It bundles the MCP server, a `/qa` slash command, and a `qa-after-build` skill that fires after you build a feature. Load it for a session:

```bash
claude --plugin-dir /abs/path/sentinel
```

Then `/sentinel-qa:qa http://localhost:3000 sign up and reach the dashboard` — or just let the skill kick in when you finish a user-facing change. (Run `npm run build` first so `dist/cli.js` exists.)

## Stack

TypeScript · Playwright (Chromium) · Anthropic SDK (Claude tool-use) · Zod · YAML. No external automation service required — everything runs locally.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and module map.

## Contributing

Issues and PRs are welcome — start with [CONTRIBUTING.md](./CONTRIBUTING.md). Please report security
issues privately per [SECURITY.md](./SECURITY.md), and be kind per the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Sentinel contributors.
