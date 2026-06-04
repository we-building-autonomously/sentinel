import { redactReport } from "../dist/report/redact.js";
// Simulate a report where the app revealed a freshly-created API key, captured
// by an `extract` step (exactly the Lettuce create-key flow).
const SECRET = "cwz_9528d50a09da3f75be1fb07928c1466c0ec390955272cc08";
const report = {
  spec: { title: "Generate API key", task: "x", intent: "y", app: { url: "https://app.example.com" } },
  plan: { goal: "g", checkpoints: [] },
  steps: [
    { index: 0, call: { name: "extract", input: { query: "the new key" } },
      result: { ok: true, summary: `Observed: the key ${SECRET} was shown`, data: `Copy it now — it is shown only once. ${SECRET}` },
      url: "https://app.example.com/settings/keys", timestamp: "" },
  ],
  verdict: { decision: "pass", confidence: 0.9, summary: `Key ${SECRET} created and visible`, checkpoints: [{ id:1, description:"shown", status:"met", evidence:`secret ${SECRET}` }], issues: [] },
  startedAt: "", finishedAt: "", durationMs: 1, runDir: "/tmp/r",
};
const red = redactReport(report);
const blob = JSON.stringify(red);
console.log("secret in step summary:", red.steps[0].result.summary.includes(SECRET));
console.log("secret in step data:   ", String(red.steps[0].result.data).includes(SECRET));
console.log("secret in verdict:     ", red.verdict.summary.includes(SECRET));
console.log("secret in checkpoint:  ", red.verdict.checkpoints[0].evidence.includes(SECRET));
console.log("masked sample:", red.steps[0].result.summary);
const leaked = blob.includes(SECRET);
console.log(leaked ? "\nFAIL — secret leaked" : "\nOK — the app-revealed API key is masked everywhere in the report (no leak).");
process.exit(leaked?1:0);
