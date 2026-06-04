---
description: QA the running app in a real browser and return a pass/fail verdict. Use after building or changing a feature to confirm it actually works for a user.
argument-hint: "<url> <what a user should be able to do>  (e.g. http://localhost:3000 sign up and reach the dashboard)"
allowed-tools: mcp__sentinel__sentinel_qa, Bash, Read
---

You are running Sentinel QA on the work just completed.

User request: `$ARGUMENTS`

Do the following:

1. **Determine the target URL and the task.** From the arguments above and the recent conversation, figure out:
   - the **URL** of the running app (if the user didn't give one, look for a dev server in the recent context — e.g. a `npm run dev` on `http://localhost:3000`; if none is running, say so and stop).
   - the **task** a real user would perform to exercise what was just built, phrased as user actions (e.g. "sign up with a new email and reach the dashboard").
   - the **intent** — what success looks like (the observable end state). If obvious from the task, let it default.
   - **login** credentials only if the feature is behind auth and they're known from context.

2. **Call the `sentinel_qa` tool** with those values. It drives a real Chromium browser like a user and returns a strict verdict.

3. **Report the verdict to the user**, concisely:
   - Lead with the decision: **PASS / FAIL / INCONCLUSIVE** and the confidence.
   - List each checkpoint with ✓ / ✗ / ? and the one-line reason.
   - Surface any runtime errors or issues it caught.
   - Link the on-disk report dir for screenshots + the full trace.

4. **If the verdict is FAIL** and the cause is a real product defect (check the triage category — `product-defect`, not `blocked`/`inconclusive`): briefly diagnose the failing checkpoint and offer to fix it. Do not auto-fix without confirming, unless the user already asked you to iterate until green.

Keep it tight — the user wants the verdict and what to do about it, not a narration of the run.
