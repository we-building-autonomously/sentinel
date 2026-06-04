import http from "node:http";
import { BrowserSession } from "../dist/browser/session.js";
import { collectPerfMetrics, evaluatePerfBudget, formatPerfMetrics } from "../dist/browser/perf-metrics.js";
import os from "node:os"; import path from "node:path";
// Server that delays ~250ms before responding (slow TTFB) to exercise the metrics.
const server = http.createServer((req,res)=>{
  setTimeout(()=>{ res.writeHead(200,{ "content-type":"text/html" });
    res.end("<!doctype html><html><head><title>t</title></head><body><h1>Perf test</h1><p>"+("x".repeat(2000))+"</p></body></html>"); }, 250);
});
await new Promise(r=>server.listen(0,r));
const base = `http://127.0.0.1:${server.address().port}`;
const s = new BrowserSession({ headed:false, actionTimeoutMs:8000, artifactsDir: path.join(os.tmpdir(),"sn-perf") });
await s.start();
await s.goto(base + "/");
const m = await collectPerfMetrics(s.page);
await s.close(); server.close();
console.log("metrics:", formatPerfMetrics(m));
console.log("raw:", JSON.stringify(m));
const within = evaluatePerfBudget(m, { loadMs: 30000 });
const exceeded = evaluatePerfBudget(m, { ttfbMs: 50 }); // 50ms budget vs ~250ms+ TTFB
console.log("within-budget violations:", within.length, "| tight-ttfb violations:", JSON.stringify(exceeded));
const ok = m.loadMs > 0 && m.ttfbMs > 100 && within.length===0 && exceeded.length===1 && exceeded[0].metric==="ttfbMs";
console.log(ok ? "\nOK — real load metrics captured; perf budget flags a slow TTFB." : "\nFAIL");
process.exit(ok?0:1);
