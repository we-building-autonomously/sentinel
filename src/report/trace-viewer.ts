import type { RunReport } from "../types.js";
import { formatUsage } from "../usage.js";

/** Embed arbitrary data as JSON in a <script> safely (no </script> break-out). */
function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build an interactive, step-by-step replay of a run: a left rail of actions
 * and a main panel showing the selected step's screenshot, the agent's
 * reasoning, the tool call, and the result. Screenshots are referenced as
 * siblings in the same run directory. Navigable by click or arrow keys.
 */
export function toTraceViewer(report: RunReport): string {
  const v = report.verdict;
  const color = v.decision === "pass" ? "#16a34a" : v.decision === "fail" ? "#dc2626" : "#d97706";

  const steps = report.steps.map((s) => ({
    index: s.index,
    thought: s.thought ?? "",
    tool: s.call.name,
    args: s.call.input,
    ok: s.result.ok,
    summary: s.result.summary,
    screenshot: s.result.screenshot ?? "",
    url: s.url,
    durationMs: s.durationMs ?? 0,
    vision: s.call.name === "click_at" || s.call.name === "type_text",
    target: s.result.target ?? null,
  }));

  const data = {
    title: report.spec.title,
    decision: v.decision,
    color,
    summary: v.summary,
    checkpoints: v.checkpoints.map((c) => ({ description: c.description, status: c.status ?? "unknown" })),
    diagnostics: report.diagnostics ?? [],
    dialogs: report.dialogs ?? [],
    steps,
    meta: {
      url: report.spec.app.url,
      durationS: (report.durationMs / 1000).toFixed(1),
      steps: report.steps.length,
      usage: report.usage ? formatUsage(report.usage) : "",
      flaky: !!report.flaky,
    },
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel trace — ${esc(report.spec.title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0e14;color:#e6e6e6;height:100vh;display:flex;flex-direction:column}
  header{padding:12px 18px;border-bottom:1px solid #1a2130;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .badge{padding:3px 12px;border-radius:999px;font-weight:700;color:#fff;background:${color};text-transform:uppercase;font-size:12px;letter-spacing:.04em}
  h1{font-size:16px;margin:0}
  .meta{color:#9aa4b2;font-size:12px}
  .flaky{background:#7c5e10;color:#fde68a;padding:1px 7px;border-radius:4px;font-size:11px}
  main{flex:1;display:flex;min-height:0}
  #rail{width:300px;border-right:1px solid #1a2130;overflow:auto;flex-shrink:0}
  .step{padding:9px 14px;border-bottom:1px solid #141925;cursor:pointer;display:flex;gap:9px;align-items:baseline}
  .step:hover{background:#141925}
  .step.active{background:#16203a}
  .step .n{color:#566;min-width:22px;font-variant-numeric:tabular-nums}
  .step .tool{color:#7dd3fc;font-weight:600}
  .step.err .tool{color:#f87171}
  .step .sum{color:#9aa4b2;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vis{font-size:11px}
  .slow{color:#fbbf24;font-size:11px;font-variant-numeric:tabular-nums}
  #panel{flex:1;overflow:auto;padding:18px 22px}
  .shotwrap{position:relative;display:inline-block}
  #shot{max-width:100%;border:1px solid #1a2130;border-radius:8px;background:#fff;display:block}
  #hl{position:absolute;border:2px solid #f59e0b;box-shadow:0 0 0 9999px rgba(0,0,0,.28);border-radius:3px;pointer-events:none}
  .row{margin:10px 0}
  .k{color:#9aa4b2;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
  .thought{background:#141925;border-left:3px solid #3b82f6;padding:9px 12px;border-radius:6px;white-space:pre-wrap}
  code{background:#1a2130;padding:1px 6px;border-radius:5px;color:#7dd3fc}
  .checks span{display:inline-block;margin-right:10px}
  .diag{color:#fca5a5;font-size:12px}
  .nav{color:#566;font-size:12px;margin-left:auto}
  kbd{background:#1a2130;border-radius:4px;padding:1px 5px;border:1px solid #2a3346}
</style></head><body>
<header>
  <span class="badge">${esc(v.decision)}</span>
  <h1>${esc(report.spec.title)}</h1>
  ${report.flaky ? '<span class="flaky">flaky</span>' : ""}
  <span class="meta" id="metaline"></span>
  <span class="nav">step with <kbd>↑</kbd><kbd>↓</kbd></span>
</header>
<main>
  <div id="rail"></div>
  <div id="panel"></div>
</main>
<script>
const D = ${safeJson(data)};
const rail = document.getElementById('rail');
const panel = document.getElementById('panel');
document.getElementById('metaline').textContent =
  D.meta.url + ' · ' + D.meta.steps + ' steps · ' + D.meta.durationS + 's' + (D.meta.usage ? ' · ' + D.meta.usage : '');

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
let active = -1;

// Step 0 is a synthetic "overview"; real steps follow.
const overview = {overview:true};
const items = [overview].concat(D.steps);

function renderRail(){
  rail.innerHTML = items.map((s,i)=>{
    if(s.overview) return '<div class="step" data-i="0"><span class="n">∑</span><span class="tool">overview</span></div>';
    const vis = s.vision ? ' <span class="vis">👁</span>' : '';
    const dur = s.durationMs > 1500 ? ' <span class="slow">'+(s.durationMs/1000).toFixed(1)+'s</span>' : '';
    return '<div class="step '+(s.ok?'':'err')+'" data-i="'+i+'"><span class="n">'+s.index+'</span>'+
      '<span><span class="tool">'+esc(s.tool)+'</span>'+vis+dur+' <span class="sum">'+esc(s.summary)+'</span></span></div>';
  }).join('');
  rail.querySelectorAll('.step').forEach(el=>el.onclick=()=>select(+el.dataset.i));
}

function renderOverview(){
  const c = D.checkpoints.map(cp=>{
    const m = cp.status==='met'?'✅':cp.status==='unmet'?'❌':'❔';
    return '<span>'+m+' '+esc(cp.description)+'</span>';
  }).join('');
  const diag = D.diagnostics.length ? '<div class="row"><div class="k">Console / network errors</div>'+
    D.diagnostics.map(d=>'<div class="diag">['+esc(d.level)+'/'+esc(d.kind)+'] '+esc(d.text)+(d.count>1?' ×'+d.count:'')+'</div>').join('')+'</div>' : '';
  const dlg = D.dialogs.length ? '<div class="row"><div class="k">Dialogs auto-handled</div>'+
    D.dialogs.map(d=>'<div class="diag">💬 '+esc(d.type)+' "'+esc(d.message)+'" → '+esc(d.action)+'</div>').join('')+'</div>' : '';
  panel.innerHTML =
    '<div class="row"><div class="k">Verdict</div><div>'+esc(D.summary)+'</div></div>'+
    '<div class="row"><div class="k">Checkpoints</div><div class="checks">'+(c||'—')+'</div></div>'+
    diag+dlg;
}

function renderStep(s){
  const shot = s.screenshot
    ? '<div class="shotwrap"><img id="shot" src="'+encodeURI(s.screenshot)+'" alt="screenshot">'+
      (s.target ? '<div id="hl"></div>' : '')+'</div>'
    : '<div class="meta">(no screenshot)</div>';
  panel.innerHTML =
    (s.thought ? '<div class="row"><div class="k">Reasoning</div><div class="thought">'+esc(s.thought)+'</div></div>' : '')+
    '<div class="row"><div class="k">Action'+(s.vision?' (vision / coordinate)':'')+'</div><div><code>'+esc(s.tool)+'('+esc(JSON.stringify(s.args))+')</code>'+(s.durationMs?' <span class="meta">'+s.durationMs+'ms</span>':'')+'</div></div>'+
    '<div class="row"><div class="k">Result</div><div>'+(s.ok?'✅':'⚠️')+' '+esc(s.summary)+'</div></div>'+
    '<div class="row"><div class="k">Page</div><div class="meta">'+esc(s.url)+'</div></div>'+
    '<div class="row">'+shot+'</div>';
  // Overlay a highlight box on the screenshot, scaled from viewport px to the
  // rendered image size (the screenshot's natural width == the viewport width).
  if(s.target){
    const img = document.getElementById('shot');
    const hl = document.getElementById('hl');
    const place = ()=>{
      if(!img.naturalWidth) return;
      const k = img.clientWidth / img.naturalWidth;
      hl.style.left = (s.target.x*k)+'px'; hl.style.top = (s.target.y*k)+'px';
      hl.style.width = (s.target.w*k)+'px'; hl.style.height = (s.target.h*k)+'px';
    };
    if(img.complete) place(); else img.onload = place;
  }
}

function select(i){
  i = Math.max(0, Math.min(items.length-1, i));
  active = i;
  rail.querySelectorAll('.step').forEach(el=>el.classList.toggle('active', +el.dataset.i===i));
  const s = items[i];
  if(s.overview) renderOverview(); else renderStep(s);
  const el = rail.querySelector('.step[data-i="'+i+'"]');
  if(el) el.scrollIntoView({block:'nearest'});
}

document.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();select(active+1);}
  else if(e.key==='ArrowUp'){e.preventDefault();select(active-1);}
});

renderRail();
select(0);
</script></body></html>`;
}
