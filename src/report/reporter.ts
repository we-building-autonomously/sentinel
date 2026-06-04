import fs from "node:fs";
import path from "node:path";
import type { RunReport, TestSpec, Step, Verdict } from "../types.js";
import { formatUsage } from "../usage.js";
import { toTraceViewer } from "./trace-viewer.js";
import { redactReport } from "./redact.js";
import { perfSummary, formatPerf } from "./perf.js";
import { formatPerfMetrics } from "../browser/perf-metrics.js";

export function writeReports(reportRaw: RunReport): void {
  const report = redactReport(reportRaw);
  const dir = report.runDir;
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, "report.md"), toMarkdown(report));
  fs.writeFileSync(path.join(dir, "report.html"), toHtml(report));
  fs.writeFileSync(path.join(dir, "trace.html"), toTraceViewer(report));
}

const DECISION_EMOJI: Record<Verdict["decision"], string> = {
  pass: "✅",
  fail: "❌",
  inconclusive: "⚠️",
};

export function toMarkdown(r: RunReport): string {
  const v = r.verdict;
  const lines: string[] = [];
  lines.push(`# ${DECISION_EMOJI[v.decision]} ${r.spec.title} — ${v.decision.toUpperCase()}`);
  lines.push("");
  lines.push(`**App:** ${r.spec.app.url}`);
  if (r.finalUrl && r.finalUrl !== r.spec.app.url)
    lines.push(`**Ended at:** ${r.finalUrl}${r.finalTitle ? ` — _${r.finalTitle}_` : ""}`);
  else if (r.finalTitle) lines.push(`**Final page:** _${r.finalTitle}_`);
  lines.push(`**Task:** ${r.spec.task}`);
  lines.push(`**Confidence:** ${(v.confidence * 100).toFixed(0)}%  ·  **Duration:** ${(r.durationMs / 1000).toFixed(1)}s  ·  **Steps:** ${r.steps.length}${r.usage ? `  ·  **Cost:** ${formatUsage(r.usage)}` : ""}`);
  const perf = formatPerf(perfSummary(r.steps));
  if (perf) lines.push(`**Perf:** ${perf}`);
  const loadPerf = r.perfMetrics ? formatPerfMetrics(r.perfMetrics) : "";
  if (loadPerf) lines.push(`**Load:** ${loadPerf}`);
  if (r.perfBudgetViolations?.length)
    lines.push(
      `**⚠ Perf budget exceeded:** ${r.perfBudgetViolations.map((v) => `${v.metric} ${v.actual}ms > ${v.budget}ms`).join(", ")}`
    );
  if (r.a11y) lines.push(`**A11y:** ${r.a11y.violations.length ? `${r.a11y.violations.length} violation(s)` : "no violations"}`);
  if (r.layout?.horizontalOverflow)
    lines.push(`**⚠ Layout:** horizontal overflow — content ${r.layout.scrollWidth}px wide vs ${r.layout.clientWidth}px viewport`);
  if (r.visual)
    lines.push(
      `**Visual:** ${r.visual.status}${r.visual.status === "diff" ? ` (${(r.visual.diffRatio * 100).toFixed(2)}% changed)` : ""}${r.visual.diffPath ? ` — [diff](${r.visual.diffPath})` : ""}`
    );
  if (r.videoPath) lines.push(`**Video:** [${r.videoPath}](${r.videoPath})`);
  if (r.triage) lines.push(`**Triage:** \`${r.triage.category}\` — ${r.triage.reason}`);
  lines.push("");
  lines.push(`> ${v.summary}`);
  lines.push("");
  lines.push("## Checkpoints");
  for (const c of v.checkpoints) {
    const mark = c.status === "met" ? "✅" : c.status === "unmet" ? "❌" : "❔";
    lines.push(`- ${mark} **${c.description}**`);
    if (c.evidence) lines.push(`  - _${c.evidence}_`);
  }
  if (v.issues.length) {
    lines.push("");
    lines.push("## Issues observed");
    for (const i of v.issues) lines.push(`- ${i}`);
  }
  if (r.diagnostics?.length) {
    lines.push("");
    lines.push("## Console & network errors");
    for (const d of r.diagnostics) {
      const tag = d.level === "error" ? "🔴" : "🟠";
      lines.push(`- ${tag} \`${d.kind}\` ${d.text}${d.count > 1 ? ` (×${d.count})` : ""}`);
    }
  }
  if (r.dialogs?.length) {
    lines.push("");
    lines.push("## Dialogs auto-handled");
    for (const d of r.dialogs) lines.push(`- 💬 \`${d.type}\` "${d.message}" → **${d.action}**`);
  }
  if (r.liveAnnouncements?.length) {
    lines.push("");
    lines.push("## Toast / status messages");
    for (const a of r.liveAnnouncements) lines.push(`- 🔔 ${a}`);
  }
  if (r.uploads?.length) {
    lines.push("");
    lines.push("## File uploads");
    for (const u of r.uploads) lines.push(`- 📎 ${u}`);
  }
  if (r.downloads?.length) {
    lines.push("");
    lines.push("## File downloads");
    for (const d of r.downloads) {
      const detail = d.error ? `❌ failed: ${d.error}` : `${d.bytes ?? "?"} bytes`;
      const link = d.path ? `[${d.filename}](${d.path})` : d.filename;
      lines.push(`- ⬇️ ${link} — ${detail}`);
    }
  }
  if (r.mockActivity?.length) {
    lines.push("");
    lines.push("## Network stubs");
    for (const m of r.mockActivity) {
      const mark = m.hits > 0 ? "✅" : "⚠️ never hit";
      lines.push(`- ${mark} \`${m.description}\` — ${m.hits} request(s)`);
    }
  }
  if (r.requestChecks?.length) {
    lines.push("");
    lines.push("## Network expectations");
    for (const c of r.requestChecks) {
      const want = [c.method ?? "any", c.url, c.status != null ? `→ ${c.status}` : "", c.bodyIncludes ? `body~"${c.bodyIncludes}"` : "", c.min === 0 ? "(must NOT occur)" : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`- ${c.met ? "✅" : "❌"} \`${want}\` — observed ${c.observed}`);
    }
  }
  if (r.textChecks?.length) {
    lines.push("");
    lines.push("## Text assertions");
    for (const c of r.textChecks) {
      const verb = c.kind === "present" ? "must contain" : "must NOT contain";
      lines.push(`- ${c.met ? "✅" : "❌"} ${verb} "${c.text}" ${c.found ? "(present)" : "(absent)"}`);
    }
  }
  if (r.urlChecks?.length) {
    lines.push("");
    lines.push("## URL assertions");
    for (const c of r.urlChecks) {
      const verb = c.kind === "contains" ? "must contain" : "must NOT contain";
      lines.push(`- ${c.met ? "✅" : "❌"} final URL ${verb} "${c.text}" ${c.found ? "(present)" : "(absent)"}`);
    }
  }
  if (r.stateChecks?.length) {
    lines.push("");
    lines.push("## State assertions");
    for (const c of r.stateChecks) {
      const what = c.scope === "cookie" ? `cookie "${c.key}"` : `${c.scope} "${c.key}"`;
      const expect = c.absent ? "must be absent" : c.value ? `must contain "${c.value}"` : "must be set";
      lines.push(`- ${c.met ? "✅" : "❌"} ${what} ${expect} ${c.present ? "(present)" : "(absent)"}`);
    }
  }
  const allHooks = [
    ...(r.hooks?.setup ?? []).map((h) => ({ ...h, phase: "setup" })),
    ...(r.hooks?.teardown ?? []).map((h) => ({ ...h, phase: "teardown" })),
  ];
  if (allHooks.length) {
    lines.push("");
    lines.push("## Setup / teardown hooks");
    for (const h of allHooks) {
      const status = h.status != null ? ` → ${h.status}` : "";
      lines.push(`- ${h.ok ? "✅" : "❌"} ${h.phase}: ${h.method} ${h.url}${status}${h.error ? ` — ${h.error}` : ""}`);
    }
  }
  if (r.downloadChecks?.length) {
    lines.push("");
    lines.push("## Download assertions");
    for (const c of r.downloadChecks) {
      const want = [c.filename ? `"${c.filename}"` : "(any download)", c.contentIncludes ? `content~"${c.contentIncludes}"` : ""].filter(Boolean).join(" ");
      lines.push(`- ${c.met ? "✅" : "❌"} ${want}`);
    }
  }
  if (r.clipboardCheck) {
    lines.push("");
    lines.push(`## Clipboard assertion`);
    lines.push(`- ${r.clipboardCheck.met ? "✅" : "❌"} clipboard must contain "${r.clipboardCheck.expected}"`);
  }
  if (r.toastCheck) {
    lines.push("");
    lines.push(`## Toast assertion`);
    lines.push(`- ${r.toastCheck.met ? "✅" : "❌"} a toast/status must contain "${r.toastCheck.expected}"`);
  }
  if (r.a11y?.violations.length) {
    lines.push("");
    lines.push(`## Accessibility (axe-core) — ${r.a11y.violations.length} violation(s)`);
    for (const v of r.a11y.violations) {
      lines.push(`- **${v.impact}** \`${v.id}\` — ${v.help} (${v.nodes} node${v.nodes === 1 ? "" : "s"})`);
      for (const sel of v.selectors) lines.push(`  - \`${sel}\``);
    }
  }
  if (r.security?.findings.length) {
    lines.push("");
    lines.push(`## Security headers — ${r.security.counts.high} high · ${r.security.counts.medium} medium · ${r.security.counts.low} low`);
    for (const f of r.security.findings) lines.push(`- **${f.severity}** \`${f.id}\` — ${f.message}`);
  }
  lines.push("");
  lines.push("## Action trace");
  for (const s of r.steps) {
    lines.push(`${s.index + 1}. \`${s.call.name}(${compactInput(s.call.input)})\` — ${s.result.summary}`);
  }
  lines.push("");
  lines.push(`_Artifacts: ${path.relative(process.cwd(), r.runDir)}_`);
  return lines.join("\n");
}

function compactInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, val]) => `${k}=${JSON.stringify(val)}`)
    .join(", ");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toHtml(r: RunReport): string {
  const v = r.verdict;
  const color =
    v.decision === "pass" ? "#16a34a" : v.decision === "fail" ? "#dc2626" : "#d97706";
  const checkpointRows = v.checkpoints
    .map((c) => {
      const mark = c.status === "met" ? "✅" : c.status === "unmet" ? "❌" : "❔";
      return `<li><span class="mark">${mark}</span> <strong>${esc(c.description)}</strong>${
        c.evidence ? `<div class="evidence">${esc(c.evidence)}</div>` : ""
      }</li>`;
    })
    .join("\n");
  const stepRows = r.steps
    .map((s) => {
      const shot = s.result.screenshot
        ? `<a href="${esc(s.result.screenshot)}" target="_blank">📷</a>`
        : "";
      const cls = s.result.ok ? "ok" : "err";
      return `<tr class="${cls}"><td>${s.index + 1}</td><td><code>${esc(s.call.name)}</code></td><td>${esc(
        compactInput(s.call.input)
      )}</td><td>${esc(s.result.summary)} ${shot}</td></tr>`;
    })
    .join("\n");
  const issues = v.issues.length
    ? `<h2>Issues observed</h2><ul>${v.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
    : "";
  const diagnostics = r.diagnostics?.length
    ? `<h2>Console &amp; network errors</h2><ul>${r.diagnostics
        .map((d) => {
          const dot = d.level === "error" ? "#dc2626" : "#d97706";
          const n = d.count > 1 ? ` ×${d.count}` : "";
          return `<li><span class="dot" style="background:${dot}"></span><code>${esc(
            d.kind
          )}</code> ${esc(d.text)}${n}</li>`;
        })
        .join("")}</ul>`
    : "";
  const dialogs = r.dialogs?.length
    ? `<h2>Dialogs auto-handled</h2><ul>${r.dialogs
        .map(
          (d) =>
            `<li>💬 <code>${esc(d.type)}</code> "${esc(d.message)}" → <strong>${esc(d.action)}</strong></li>`
        )
        .join("")}</ul>`
    : "";
  const liveAnn = r.liveAnnouncements?.length
    ? `<h2>Toast / status messages</h2><ul>${r.liveAnnouncements.map((a) => `<li>🔔 ${esc(a)}</li>`).join("")}</ul>`
    : "";
  const uploads = r.uploads?.length
    ? `<h2>File uploads</h2><ul>${r.uploads.map((u) => `<li>📎 ${esc(u)}</li>`).join("")}</ul>`
    : "";
  const downloads = r.downloads?.length
    ? `<h2>File downloads</h2><ul>${r.downloads
        .map((d) => {
          const name = d.path ? `<a href="${esc(d.path)}">${esc(d.filename)}</a>` : esc(d.filename);
          const detail = d.error
            ? `<span style="color:#f87171">failed: ${esc(d.error)}</span>`
            : `${d.bytes ?? "?"} bytes${d.bytes === 0 ? ' <span style="color:#f87171">(empty)</span>' : ""}`;
          return `<li>⬇️ ${name} — ${detail}</li>`;
        })
        .join("")}</ul>`
    : "";
  const mocks = r.mockActivity?.length
    ? `<h2>Network stubs</h2><ul>${r.mockActivity
        .map((m) => {
          const dot = m.hits > 0 ? "#16a34a" : "#d97706";
          const tag = m.hits > 0 ? `${m.hits} request(s)` : "never hit";
          return `<li><span class="dot" style="background:${dot}"></span><code>${esc(m.description)}</code> — ${tag}</li>`;
        })
        .join("")}</ul>`
    : "";
  const reqChecks = r.requestChecks?.length
    ? `<h2>Network expectations</h2><ul>${r.requestChecks
        .map((c) => {
          const want = [c.method ?? "any", c.url, c.status != null ? `→ ${c.status}` : "", c.bodyIncludes ? `body~"${c.bodyIncludes}"` : "", c.min === 0 ? "(must NOT occur)" : ""]
            .filter(Boolean)
            .join(" ");
          return `<li><span class="dot" style="background:${c.met ? "#16a34a" : "#dc2626"}"></span><code>${esc(want)}</code> — observed ${c.observed}</li>`;
        })
        .join("")}</ul>`
    : "";
  const textChecks = r.textChecks?.length
    ? `<h2>Text assertions</h2><ul>${r.textChecks
        .map((c) => {
          const verb = c.kind === "present" ? "must contain" : "must NOT contain";
          return `<li><span class="dot" style="background:${c.met ? "#16a34a" : "#dc2626"}"></span>${verb} <code>${esc(c.text)}</code> — ${c.found ? "present" : "absent"}</li>`;
        })
        .join("")}</ul>`
    : "";
  const urlChecks = r.urlChecks?.length
    ? `<h2>URL assertions</h2><ul>${r.urlChecks
        .map((c) => {
          const verb = c.kind === "contains" ? "must contain" : "must NOT contain";
          return `<li><span class="dot" style="background:${c.met ? "#16a34a" : "#dc2626"}"></span>final URL ${verb} <code>${esc(c.text)}</code> — ${c.found ? "present" : "absent"}</li>`;
        })
        .join("")}</ul>`
    : "";
  const stateChecks = r.stateChecks?.length
    ? `<h2>State assertions</h2><ul>${r.stateChecks
        .map((c) => {
          const what = c.scope === "cookie" ? `cookie ${esc(c.key)}` : `${c.scope} ${esc(c.key)}`;
          const expect = c.absent ? "must be absent" : c.value ? `must contain "${esc(c.value)}"` : "must be set";
          return `<li><span class="dot" style="background:${c.met ? "#16a34a" : "#dc2626"}"></span><code>${what}</code> ${expect} — ${c.present ? "present" : "absent"}</li>`;
        })
        .join("")}</ul>`
    : "";
  const hookRows = [
    ...(r.hooks?.setup ?? []).map((h) => ({ ...h, phase: "setup" })),
    ...(r.hooks?.teardown ?? []).map((h) => ({ ...h, phase: "teardown" })),
  ];
  const hooks = hookRows.length
    ? `<h2>Setup / teardown hooks</h2><ul>${hookRows
        .map(
          (h) =>
            `<li><span class="dot" style="background:${h.ok ? "#16a34a" : "#dc2626"}"></span>${h.phase}: <code>${esc(h.method)} ${esc(h.url)}</code>${h.status != null ? ` → ${h.status}` : ""}${h.error ? ` — ${esc(h.error)}` : ""}</li>`
        )
        .join("")}</ul>`
    : "";
  const downloadChecks = r.downloadChecks?.length
    ? `<h2>Download assertions</h2><ul>${r.downloadChecks
        .map((c) => {
          const want = [c.filename ? `"${c.filename}"` : "(any download)", c.contentIncludes ? `content~"${c.contentIncludes}"` : ""].filter(Boolean).join(" ");
          return `<li><span class="dot" style="background:${c.met ? "#16a34a" : "#dc2626"}"></span><code>${esc(want)}</code></li>`;
        })
        .join("")}</ul>`
    : "";
  const clipboardChk = r.clipboardCheck
    ? `<h2>Clipboard assertion</h2><ul><li><span class="dot" style="background:${r.clipboardCheck.met ? "#16a34a" : "#dc2626"}"></span>must contain <code>${esc(r.clipboardCheck.expected)}</code></li></ul>`
    : "";
  const toastChk = r.toastCheck
    ? `<h2>Toast assertion</h2><ul><li><span class="dot" style="background:${r.toastCheck.met ? "#16a34a" : "#dc2626"}"></span>a toast/status must contain <code>${esc(r.toastCheck.expected)}</code></li></ul>`
    : "";
  const A11Y_DOT: Record<string, string> = { critical: "#dc2626", serious: "#ea580c", moderate: "#d97706", minor: "#9aa4b2" };
  const a11y = r.a11y?.violations.length
    ? `<h2>Accessibility — ${r.a11y.violations.length} violation(s)</h2><ul>${r.a11y.violations
        .map((v) => {
          const sels = v.selectors.length
            ? `<div class="evidence">${v.selectors.map((s) => `<code>${esc(s)}</code>`).join(" ")}</div>`
            : "";
          return `<li><span class="dot" style="background:${A11Y_DOT[v.impact] ?? "#9aa4b2"}"></span><strong>${esc(
            v.impact
          )}</strong> <code>${esc(v.id)}</code> — ${esc(v.help)} (${v.nodes})${sels}</li>`;
        })
        .join("")}</ul>`
    : "";
  const SEC_DOT: Record<string, string> = { high: "#dc2626", medium: "#ea580c", low: "#9aa4b2" };
  const security = r.security?.findings.length
    ? `<h2>Security headers — ${r.security.counts.high} high · ${r.security.counts.medium} medium · ${r.security.counts.low} low</h2><ul>${r.security.findings
        .map(
          (f) =>
            `<li><span class="dot" style="background:${SEC_DOT[f.severity]}"></span><strong>${esc(f.severity)}</strong> <code>${esc(f.id)}</code> — ${esc(f.message)}</li>`
        )
        .join("")}</ul>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel — ${esc(r.spec.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; margin: 0; background:#0b0e14; color:#e6e6e6; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 32px 24px 80px; }
  .badge { display:inline-block; padding:4px 14px; border-radius:999px; font-weight:700; color:#fff; background:${color}; text-transform:uppercase; letter-spacing:.04em; font-size:13px;}
  h1 { font-size: 24px; margin:.4em 0; }
  .meta { color:#9aa4b2; font-size:13px; margin-bottom:16px; }
  .summary { background:#141925; border-left:4px solid ${color}; padding:14px 18px; border-radius:8px; margin:18px 0; }
  h2 { font-size:16px; margin-top:28px; border-bottom:1px solid #222a38; padding-bottom:6px;}
  ul { list-style:none; padding:0; }
  li { padding:8px 0; border-bottom:1px solid #1a2130; }
  .mark { margin-right:8px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:8px; }
  .evidence { color:#9aa4b2; font-size:13px; margin:4px 0 0 26px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:7px 9px; border-bottom:1px solid #1a2130; vertical-align:top; }
  tr.err td { background:rgba(220,38,38,.08); }
  code { background:#1a2130; padding:1px 6px; border-radius:5px; color:#7dd3fc;}
  a { color:#7dd3fc; }
</style></head>
<body><div class="wrap">
  <span class="badge">${esc(v.decision)}</span>
  <h1>${esc(r.spec.title)}</h1>
  <div class="meta">
    ${esc(r.spec.app.url)} · confidence ${(v.confidence * 100).toFixed(0)}% ·
    ${(r.durationMs / 1000).toFixed(1)}s · ${r.steps.length} steps${
      r.usage ? ` · ${esc(formatUsage(r.usage))}` : ""
    }${(() => {
      const p = formatPerf(perfSummary(r.steps));
      return p ? ` · ${esc(p)}` : "";
    })()} · ${esc(r.startedAt)}
  </div>
  ${
    (r.finalUrl && r.finalUrl !== r.spec.app.url) || r.finalTitle
      ? `<div class="meta">↳ ended at ${r.finalUrl && r.finalUrl !== r.spec.app.url ? `<code>${esc(r.finalUrl)}</code>` : "the start page"}${r.finalTitle ? ` · <strong>${esc(r.finalTitle)}</strong>` : ""}</div>`
      : ""
  }
  ${r.layout?.horizontalOverflow ? `<div class="meta"><span style="color:#f87171">⚠ layout: horizontal overflow — content ${r.layout.scrollWidth}px wide vs ${r.layout.clientWidth}px viewport</span></div>` : ""}
  ${r.perfMetrics && formatPerfMetrics(r.perfMetrics) ? `<div class="meta">⚡ ${esc(formatPerfMetrics(r.perfMetrics))}${r.perfBudgetViolations?.length ? ` · <span style="color:#f87171">budget exceeded: ${esc(r.perfBudgetViolations.map((v) => `${v.metric} ${v.actual}>${v.budget}ms`).join(", "))}</span>` : ""}</div>` : ""}
  ${r.visual ? `<div class="meta">🖼 visual: <strong style="color:${r.visual.status === "match" || r.visual.status === "new-baseline" ? "#16a34a" : "#f87171"}">${esc(r.visual.status)}</strong>${r.visual.status === "diff" ? ` (${(r.visual.diffRatio * 100).toFixed(2)}% changed)` : ""}${r.visual.diffPath ? ` · <a href="${esc(r.visual.diffPath)}">diff image</a>` : ""}</div>${r.visual.diffPath ? `<img src="${esc(r.visual.diffPath)}" style="max-width:100%;border:1px solid #1a2130;border-radius:8px;margin:8px 0">` : ""}` : ""}
  ${r.videoPath ? `<video controls src="${esc(r.videoPath)}" style="max-width:100%;border-radius:8px;border:1px solid #1a2130;margin:8px 0"></video>` : ""}
  ${r.triage ? `<div class="meta">🧭 triage: <strong>${esc(r.triage.category)}</strong> — ${esc(r.triage.reason)}</div>` : ""}
  <div class="summary">${esc(v.summary)}</div>
  <p><strong>Task:</strong> ${esc(r.spec.task)}<br><strong>Intent:</strong> ${esc(r.spec.intent)}</p>
  <h2>Checkpoints</h2>
  <ul>${checkpointRows}</ul>
  ${issues}
  ${diagnostics}
  ${dialogs}
  ${liveAnn}
  ${uploads}
  ${downloads}
  ${mocks}
  ${reqChecks}
  ${textChecks}
  ${urlChecks}
  ${stateChecks}
  ${hooks}
  ${downloadChecks}
  ${clipboardChk}
  ${toastChk}
  ${a11y}
  ${security}
  <h2>Action trace <a href="trace.html" style="font-size:13px;font-weight:400">▶ open interactive replay</a></h2>
  <table><thead><tr><th>#</th><th>tool</th><th>args</th><th>result</th></tr></thead>
  <tbody>${stepRows}</tbody></table>
</div></body></html>`;
}
