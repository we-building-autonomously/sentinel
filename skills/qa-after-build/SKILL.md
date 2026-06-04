---
name: qa-after-build
description: Use after building, changing, or fixing a user-facing feature in a web app to verify it actually works for a real user — not just that the code compiles. Drives a real browser via Sentinel and returns a strict pass/fail verdict with per-checkpoint reasoning. Trigger when a frontend/full-stack change is "done", before claiming success, or when the user asks to QA / verify / test a flow end-to-end in the browser.
allowed-tools: mcp__sentinel__sentinel_qa, Bash, Read
---

# QA a feature in a real browser before calling it done

Code compiling is not the same as a feature working. When you finish a user-facing change to a web app, verify it the way a QA engineer would: drive a real browser as a user and check the end state. Sentinel does this and returns a strict verdict.

## When to use this

- You just built or changed a user-facing flow (auth, forms, checkout, navigation, a new page) and are about to tell the user it's done.
- The user asks to QA, verify, smoke-test, or "make sure it works" end-to-end.
- A previous QA run came back FAIL and you've made a fix — re-run to confirm green.

Skip it for pure backend/library/config changes with no browser-observable behavior, or when no app is running to test against.

## How to run it

1. **Make sure the app is running** and you know its URL. If a dev server isn't up, start it (e.g. `npm run dev`) and wait for it to be reachable before testing. Prefer the local dev URL (e.g. `http://localhost:3000`).

2. **Call `sentinel_qa`** with:
   - `url` — where the app is running.
   - `task` — what a real user does to exercise the change, in user terms ("create a project named Test and confirm it appears in the list"). Make it specific to what you just built.
   - `intent` (optional) — the observable success state. Omit to let it default to "the task completes".
   - `user` / `pass` (optional) — only if the flow is behind auth and you know the credentials from context.
   - `expectText` / `forbidText` (optional) — text that must / must not appear on the final page, when you have a concrete assertion.

3. **Read the verdict, not just the decision.** The result has per-checkpoint `met` / `unmet` / `unknown` with evidence, a triage category, captured runtime errors, and a report dir. A FAIL with triage `product-defect` is a real bug; `blocked` or `inconclusive` means the run couldn't reach a conclusion (e.g. a CAPTCHA, a down server) — treat those differently.

## Acting on the result

- **PASS** → report it briefly with the checkpoints that passed, then you may claim done.
- **FAIL (product-defect)** → name the failing checkpoint and its evidence, diagnose the root cause in the code, fix it, and re-run `sentinel_qa` to confirm green. If the user asked you to iterate until passing, keep looping; otherwise fix once and confirm.
- **INCONCLUSIVE / blocked** → say why it couldn't conclude and what's needed (credentials, a reachable URL, removing a CAPTCHA) rather than reporting a false pass.

Always surface the report dir so the user can open the HTML report with screenshots and the full browser trace.
