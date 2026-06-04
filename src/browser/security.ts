/**
 * A lightweight security-header audit of the page's main document response.
 * Deterministic and pure (the session captures the headers; this evaluates
 * them) — a distinct QA dimension teams routinely want alongside functional
 * checks. It flags MISSING defenses, not vulnerabilities it can't see, so it's
 * conservative: every finding maps to a well-known recommended header.
 */
export type SecuritySeverity = "high" | "medium" | "low";

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  message: string;
}

export interface SecurityAudit {
  findings: SecurityFinding[];
  counts: { high: number; medium: number; low: number };
}

/** Tally findings into a SecurityAudit (findings + severity counts). */
export function toAudit(findings: SecurityFinding[]): SecurityAudit {
  return {
    findings,
    counts: {
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    },
  };
}

/** A cookie's security-relevant flags (as Playwright's context.cookies() returns them). */
export interface AuditCookie {
  name: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

// Session/auth-looking cookie names — those are the security-relevant ones to
// audit (flagging every analytics cookie would be noise).
const SESSION_RE = /(?:sess|auth|token|jwt|csrf|xsrf|login|sso)/i;
const SESSION_NAMES = /^(?:sid|sessionid|jsessionid|phpsessid|asp\.net_sessionid|connect\.sid)$/i;
const isSessionCookie = (name: string) => SESSION_RE.test(name) || SESSION_NAMES.test(name);

/** Flag session cookies missing HttpOnly / Secure / a CSRF-safe SameSite. */
export function auditCookies(cookies: AuditCookie[], opts: { https: boolean }): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  for (const ck of cookies) {
    if (!isSessionCookie(ck.name)) continue;
    if (!ck.httpOnly) {
      out.push({
        id: `cookie-httponly:${ck.name}`,
        severity: "medium",
        message: `Session cookie "${ck.name}" is not HttpOnly — readable by JavaScript (an XSS could steal it).`,
      });
    }
    if (opts.https && !ck.secure) {
      out.push({
        id: `cookie-secure:${ck.name}`,
        severity: "medium",
        message: `Session cookie "${ck.name}" is not Secure — it may be sent over plain HTTP.`,
      });
    }
    if (!ck.sameSite || ck.sameSite.toLowerCase() === "none") {
      out.push({
        id: `cookie-samesite:${ck.name}`,
        severity: "low",
        message: `Session cookie "${ck.name}" has SameSite=${ck.sameSite ?? "unset"} — broader CSRF exposure.`,
      });
    }
  }
  return out;
}

/** Full security audit: response headers + session-cookie flags. */
export function auditSecurity(input: {
  headers: Record<string, string>;
  cookies: AuditCookie[];
  https: boolean;
}): SecurityAudit {
  return toAudit([
    ...headerFindings(input.headers, { https: input.https }),
    ...auditCookies(input.cookies, { https: input.https }),
  ]);
}

/**
 * Audit response headers (lower-cased keys, as Playwright returns them).
 * `https` enables HSTS checking, which only applies to TLS pages.
 */
export function auditSecurityHeaders(
  headers: Record<string, string>,
  opts: { https: boolean }
): SecurityAudit {
  return toAudit(headerFindings(headers, opts));
}

function headerFindings(headers: Record<string, string>, opts: { https: boolean }): SecurityFinding[] {
  const h = (name: string) => headers[name.toLowerCase()];
  const findings: SecurityFinding[] = [];
  const csp = h("content-security-policy");

  if (!csp) {
    findings.push({
      id: "content-security-policy",
      severity: "high",
      message: "No Content-Security-Policy header — no defense-in-depth against XSS / content injection.",
    });
  }
  if (!/\bnosniff\b/i.test(h("x-content-type-options") ?? "")) {
    findings.push({
      id: "x-content-type-options",
      severity: "medium",
      message: "Missing 'X-Content-Type-Options: nosniff' — the browser may MIME-sniff responses.",
    });
  }
  const frameProtected = !!h("x-frame-options") || /frame-ancestors/i.test(csp ?? "");
  if (!frameProtected) {
    findings.push({
      id: "x-frame-options",
      severity: "medium",
      message: "No X-Frame-Options and no CSP frame-ancestors — the page can be framed (clickjacking risk).",
    });
  }
  if (opts.https && !h("strict-transport-security")) {
    findings.push({
      id: "strict-transport-security",
      severity: "medium",
      message: "HTTPS page with no Strict-Transport-Security (HSTS) header.",
    });
  }
  if (!h("referrer-policy")) {
    findings.push({
      id: "referrer-policy",
      severity: "low",
      message: "No Referrer-Policy header — the full URL may leak as the referrer to other origins.",
    });
  }
  for (const leak of ["server", "x-powered-by"]) {
    const v = h(leak);
    if (v) {
      findings.push({ id: leak, severity: "low", message: `'${leak}: ${v}' header leaks server/stack details.` });
    }
  }

  return findings;
}

/** A compact one-line summary for the judge prompt / report header. */
export function formatSecurity(audit: SecurityAudit): string {
  const { high, medium, low } = audit.counts;
  if (!audit.findings.length) return "no missing security headers";
  return `${high} high · ${medium} medium · ${low} low — ${audit.findings.map((f) => f.id).join(", ")}`;
}
