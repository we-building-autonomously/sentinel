import { describe, it, expect } from "vitest";
import { auditSecurityHeaders, auditCookies, auditSecurity, formatSecurity } from "./security.js";

const ids = (a: ReturnType<typeof auditSecurityHeaders>) => a.findings.map((f) => f.id);

describe("auditSecurityHeaders", () => {
  it("flags all missing headers on a bare response", () => {
    const a = auditSecurityHeaders({}, { https: true });
    expect(ids(a)).toEqual(
      expect.arrayContaining([
        "content-security-policy",
        "x-content-type-options",
        "x-frame-options",
        "strict-transport-security",
        "referrer-policy",
      ])
    );
    expect(a.counts.high).toBe(1); // CSP
    expect(a.counts.medium).toBeGreaterThanOrEqual(3);
  });

  it("passes a well-secured response with no findings", () => {
    const a = auditSecurityHeaders(
      {
        "content-security-policy": "default-src 'self'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "strict-transport-security": "max-age=31536000",
        "referrer-policy": "no-referrer",
      },
      { https: true }
    );
    expect(a.findings).toEqual([]);
  });

  it("accepts CSP frame-ancestors in lieu of X-Frame-Options", () => {
    const a = auditSecurityHeaders(
      { "content-security-policy": "frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "x", "strict-transport-security": "x" },
      { https: true }
    );
    expect(ids(a)).not.toContain("x-frame-options");
  });

  it("does not require HSTS on a non-HTTPS page", () => {
    const a = auditSecurityHeaders({}, { https: false });
    expect(ids(a)).not.toContain("strict-transport-security");
  });

  it("flags server / x-powered-by info leaks as low severity", () => {
    const a = auditSecurityHeaders({ server: "nginx/1.2", "x-powered-by": "Express" }, { https: false });
    const leaks = a.findings.filter((f) => f.id === "server" || f.id === "x-powered-by");
    expect(leaks).toHaveLength(2);
    expect(leaks.every((f) => f.severity === "low")).toBe(true);
  });

  it("requires nosniff specifically, not just any x-content-type-options value", () => {
    const a = auditSecurityHeaders({ "x-content-type-options": "something-else" }, { https: false });
    expect(ids(a)).toContain("x-content-type-options");
  });

  it("formatSecurity summarizes counts + ids, or 'no missing' when clean", () => {
    expect(formatSecurity({ findings: [], counts: { high: 0, medium: 0, low: 0 } })).toMatch(/no missing/);
    const a = auditSecurityHeaders({}, { https: true });
    expect(formatSecurity(a)).toMatch(/high · .* medium/);
  });
});

describe("auditCookies", () => {
  it("flags a session cookie missing HttpOnly / Secure / SameSite", () => {
    const f = auditCookies([{ name: "sessionid", httpOnly: false, secure: false, sameSite: "None" }], { https: true });
    expect(f.map((x) => x.id)).toEqual(
      expect.arrayContaining(["cookie-httponly:sessionid", "cookie-secure:sessionid", "cookie-samesite:sessionid"])
    );
    expect(f.find((x) => x.id.startsWith("cookie-httponly"))!.severity).toBe("medium");
    expect(f.find((x) => x.id.startsWith("cookie-samesite"))!.severity).toBe("low");
  });

  it("passes a well-configured session cookie", () => {
    expect(auditCookies([{ name: "auth_token", httpOnly: true, secure: true, sameSite: "Lax" }], { https: true })).toEqual([]);
  });

  it("ignores non-session cookies (analytics etc.)", () => {
    expect(auditCookies([{ name: "_ga", httpOnly: false, secure: false }], { https: true })).toEqual([]);
  });

  it("does not require Secure on a non-HTTPS page", () => {
    const f = auditCookies([{ name: "jwt", httpOnly: true, secure: false, sameSite: "Lax" }], { https: false });
    expect(f).toEqual([]);
  });

  it("auditSecurity combines header + cookie findings into one audit", () => {
    const a = auditSecurity({
      headers: { "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "strict-transport-security": "x", "referrer-policy": "x" },
      cookies: [{ name: "sid", httpOnly: false, secure: true, sameSite: "Lax" }],
      https: true,
    });
    expect(a.findings.map((f) => f.id)).toEqual(["cookie-httponly:sid"]); // headers clean, only the cookie flag
    expect(a.counts.medium).toBe(1);
  });
});
