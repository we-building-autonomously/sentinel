import { runSpec } from "../dist/runner.js";
const exploding = { async turn(){throw new Error("nope")}, async structured(){throw new Error("nope")} };
process.env.SN_BASE = "http://127.0.0.1:1";
const spec = () => ({
  title: "Signup {{randomString}}",
  task: "Register with {{randomEmail}}",
  intent: "Account created for {{randomEmail}}",
  app: { url: "{{env.SN_BASE}}/signup", auth: { username: "{{randomEmail}}", password: "Pw-{{uuid}}" } },
});
async function once(){
  const r = await runSpec(spec(), { config:{ apiKey:"test", runsDir:"/tmp/sn-tmpl-runs" }, clients:{ llm:exploding, judge:exploding } });
  return r.spec;
}
const a = await once();
const b = await once();
console.log("run A email:", a.app.auth.username, "| url:", a.app.url);
console.log("run B email:", b.app.auth.username);
console.log("task rendered:", a.task);
const ok = a.app.url==="http://127.0.0.1:1/signup" &&
  /qa\+[a-z0-9]{8}@example\.com/.test(a.app.auth.username) &&
  a.app.auth.username !== b.app.auth.username &&     // FRESH per run
  a.task === `Register with ${a.app.auth.username}`; // same email reused within a run
console.log(ok ? "\nOK — templating: fresh data per run, env resolved, token reused consistently within a run." : "\nFAIL");
process.exit(ok?0:1);
