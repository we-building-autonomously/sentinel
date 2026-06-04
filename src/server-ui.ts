/** The single-page dashboard served at `/`. Vanilla JS, no build step. */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel — live test runner</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --dim:#8b949e;
    --green:#3fb950; --red:#f85149; --yellow:#d29922; --blue:#58a6ff; --accent:#bc8cff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:18px; margin:0; font-weight:600; }
  header .dot { width:10px; height:10px; border-radius:50%; background:var(--accent); }
  header .sub { color:var(--dim); font-size:13px; }
  main { display:grid; grid-template-columns: 360px 1fr; gap:0; height:calc(100vh - 61px); }
  .form { padding:20px 24px; border-right:1px solid var(--border); overflow:auto; }
  .form label { display:block; font-size:12px; color:var(--dim); margin:14px 0 5px; text-transform:uppercase; letter-spacing:.04em; }
  .form input[type=text], .form textarea { width:100%; background:var(--bg); border:1px solid var(--border);
    color:var(--fg); border-radius:6px; padding:8px 10px; font:inherit; }
  .form textarea { resize:vertical; min-height:64px; }
  .form .row { display:flex; gap:10px; }
  .form .row > div { flex:1; }
  .chk { display:flex; align-items:center; gap:8px; margin-top:14px; color:var(--dim); }
  button { margin-top:18px; width:100%; background:var(--accent); color:#1a1024; border:0; border-radius:6px;
    padding:11px; font:600 14px inherit; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .stream { padding:20px 24px; overflow:auto; }
  .preview { display:none; position:sticky; top:0; background:var(--bg); padding-bottom:14px; margin-bottom:6px; z-index:1; }
  .preview.show { display:block; }
  .preview img { width:100%; border:1px solid var(--border); border-radius:8px; display:block; }
  .preview .cap { color:var(--dim); font-size:12px; margin-top:6px; font-family:ui-monospace,Menlo,monospace; }
  .ev.step { cursor:pointer; } .ev.step:hover { background:rgba(188,140,255,.06); border-radius:5px; }
  .ev.step.shot .tool::after { content:' 📷'; }
  .verdict { border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:18px; display:none; }
  .verdict.show { display:block; }
  .verdict .badge { font-weight:700; font-size:15px; padding:3px 10px; border-radius:5px; }
  .b-pass{background:rgba(63,185,80,.15);color:var(--green)} .b-fail{background:rgba(248,81,73,.15);color:var(--red)}
  .b-inconclusive{background:rgba(210,153,34,.15);color:var(--yellow)}
  .verdict h3 { margin:0 0 8px; display:flex; align-items:center; gap:10px; }
  .verdict .meta { color:var(--dim); font-size:12px; margin-left:auto; font-weight:400; }
  .cp { padding:3px 0; } .cp .m{color:var(--green)} .cp .u{color:var(--red)} .cp .k{color:var(--yellow)}
  .verdict a { color:var(--blue); }
  .timeline { border-left:2px solid var(--border); margin-left:6px; padding-left:0; }
  .ev { position:relative; padding:7px 0 7px 22px; }
  .ev::before { content:''; position:absolute; left:-7px; top:13px; width:10px; height:10px; border-radius:50%;
    background:var(--border); border:2px solid var(--bg); }
  .ev.phase::before{background:var(--blue)} .ev.step::before{background:var(--accent)}
  .ev.err::before{background:var(--red)}
  .ev .t { color:var(--dim); font-size:11px; }
  .ev .tool { color:var(--accent); font-weight:600; font-family:ui-monospace,Menlo,monospace; }
  .ev.bad .tool { color:var(--red); }
  .ev .sum { color:var(--fg); }
  .ev.phase .label { color:var(--blue); font-weight:600; text-transform:capitalize; }
  .ev .thought { color:var(--dim); font-style:italic; font-size:12.5px; }
  .empty { color:var(--dim); padding:40px 0; text-align:center; }
  .history { margin-top:24px; border-top:1px solid var(--border); padding-top:14px; }
  .history h2 { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; margin:0 0 8px; }
  .run { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:6px; text-decoration:none; color:var(--fg); }
  .run:hover { background:rgba(255,255,255,.05); }
  .run .pill { width:8px; height:8px; border-radius:50%; flex:none; }
  .run .ttl { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .run .when { color:var(--dim); font-size:11px; flex:none; }
  .run.p-pass .pill{background:var(--green)} .run.p-fail .pill{background:var(--red)} .run.p-inconclusive .pill{background:var(--yellow)}
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>Sentinel</h1>
  <span class="sub">browser-native QA agent — live run</span>
</header>
<main>
  <form class="form" id="f">
    <label>App URL</label>
    <input type="text" id="url" placeholder="https://demo.playwright.dev/todomvc" required>
    <label>Task — what the user does</label>
    <textarea id="task" placeholder='Add a todo "buy milk" and mark it complete' required></textarea>
    <label>Intent — what success looks like</label>
    <textarea id="intent" placeholder='"buy milk" appears and is shown as completed'></textarea>
    <div class="row">
      <div><label>Username (optional)</label><input type="text" id="user"></div>
      <div><label>Password (optional)</label><input type="text" id="pass"></div>
    </div>
    <label class="chk"><input type="checkbox" id="headed"> Show the browser window (headed)</label>
    <button id="go" type="submit">▶ Run test</button>
    <div class="history"><h2>Recent runs</h2><div id="runs"></div></div>
  </form>
  <div class="stream">
    <div class="preview" id="preview"><img id="shot" alt="live screenshot"><div class="cap" id="cap"></div></div>
    <div class="verdict" id="verdict"></div>
    <div class="timeline" id="tl"><div class="empty">Fill in a task and hit Run — events stream here live, with a screenshot after each action.</div></div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const tl = $('tl'), verdict = $('verdict'), go = $('go');
const preview = $('preview'), shot = $('shot'), cap = $('cap');
const now = () => new Date().toLocaleTimeString();
function add(cls, html) {
  if (tl.querySelector('.empty')) tl.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'ev ' + cls;
  d.innerHTML = '<div class="t">' + now() + '</div>' + html;
  tl.appendChild(d); d.scrollIntoView({block:'nearest'});
  return d;
}
function showShot(url, caption) { preview.classList.add('show'); shot.src = url; cap.textContent = caption || ''; }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function rel(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago'; return Math.floor(s/86400) + 'd ago';
}
async function loadRuns() {
  try {
    const runs = await (await fetch('/api/runs')).json();
    const el = $('runs');
    if (!runs.length) { el.innerHTML = '<div style="color:var(--dim);font-size:13px">No runs yet.</div>'; return; }
    el.innerHTML = runs.map(r => {
      const cls = r.decision === 'pass' ? 'p-pass' : r.decision === 'fail' ? 'p-fail' : 'p-inconclusive';
      return '<a class="run ' + cls + '" href="' + r.reportUrl + '" target="_blank" title="' + esc(r.title) + '">' +
        '<span class="pill"></span><span class="ttl">' + esc(r.title) + '</span><span class="when">' + rel(r.startedAt) + '</span></a>';
    }).join('');
  } catch (e) { /* ignore */ }
}
// Click any step with a 📷 to revisit its screenshot in the preview.
tl.addEventListener('click', (e) => {
  const row = e.target.closest('.ev.step.shot');
  if (row) showShot(row.dataset.shot, row.dataset.cap);
});

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  tl.innerHTML = ''; verdict.className = 'verdict'; verdict.innerHTML = '';
  preview.className = 'preview'; shot.removeAttribute('src');
  go.disabled = true; go.textContent = '● running…';
  const body = { url:$('url').value, task:$('task').value, intent:$('intent').value,
    user:$('user').value||undefined, pass:$('pass').value||undefined, headed:$('headed').checked };
  try {
    const res = await fetch('/api/run', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream:true });
      const frames = buf.split('\\n\\n'); buf = frames.pop();
      for (const f of frames) handle(f);
    }
  } catch (err) { add('err bad', '<span class="sum">Connection error: ' + esc(err.message) + '</span>'); }
  go.disabled = false; go.textContent = '▶ Run test';
  loadRuns(); // refresh history with the run that just finished
});
loadRuns(); // populate history on load

function handle(frame) {
  const ev = (frame.match(/^event: (.+)$/m) || [])[1];
  const dataLine = (frame.match(/^data: (.+)$/m) || [])[1];
  if (!ev || !dataLine) return;
  const d = JSON.parse(dataLine);
  if (ev === 'started') add('phase', '<span class="label">▶ starting</span> <span class="sum">' + esc(d.title) + ' — ' + esc(d.url) + '</span>');
  else if (ev === 'phase') add('phase', '<span class="label">' + esc(d.phase) + '</span>');
  else if (ev === 'step') {
    const el = add('step' + (d.ok ? '' : ' bad'),
      '<span class="tool">[' + d.index + '] ' + esc(d.tool) + '</span> <span class="sum">' + esc(d.summary) + '</span>' +
      (d.thought ? '<div class="thought">' + esc(d.thought) + '</div>' : ''));
    if (d.screenshot) {
      el.classList.add('shot');
      el.dataset.shot = d.screenshot;
      el.dataset.cap = '[' + d.index + '] ' + d.tool;
      showShot(d.screenshot, el.dataset.cap); // auto-advance the preview to the latest action
    }
  }
  else if (ev === 'error') add('err bad', '<span class="sum">✗ ' + esc(d.message) + '</span>');
  else if (ev === 'verdict') showVerdict(d);
}

function showVerdict(d) {
  const cls = d.decision === 'pass' ? 'b-pass' : d.decision === 'fail' ? 'b-fail' : 'b-inconclusive';
  const cps = d.checkpoints.map(c => {
    const m = c.status === 'met' ? '<span class="m">✓</span>' : c.status === 'unmet' ? '<span class="u">✗</span>' : '<span class="k">?</span>';
    return '<div class="cp">' + m + ' ' + esc(c.description) + '</div>';
  }).join('');
  const iss = (d.issues||[]).map(i => '<div class="cp" style="color:var(--dim)">• ' + esc(i) + '</div>').join('');
  verdict.className = 'verdict show';
  verdict.innerHTML =
    '<h3><span class="badge ' + cls + '">' + d.decision.toUpperCase() + '</span>' +
    '<span class="meta">' + Math.round(d.confidence*100) + '% conf · ' + (d.durationMs/1000).toFixed(1) + 's · $' + d.costUsd.toFixed(4) +
    (d.reportUrl ? ' · <a href="' + d.reportUrl + '" target="_blank">full report ↗</a>' : '') + '</span></h3>' +
    '<div class="sum" style="margin-bottom:10px">' + esc(d.summary) + '</div>' + cps + (iss ? '<div style="margin-top:8px">' + iss + '</div>' : '');
}
</script>
</body>
</html>`;
