import { describe, it, expect } from "vitest";
import { scrubSecrets, containsSecret } from "./secrets.js";

describe("scrubSecrets", () => {
  it("masks a provider-prefixed key (the provider-prefixed case)", () => {
    const s = scrubSecrets("Your key: cwz_9528d50a09da3f75be1fb07928c1466c0ec390955272cc08 — copy it now");
    expect(s).not.toContain("cwz_9528d50a09da3f75");
    expect(s).toContain("«redacted-secret»");
  });

  it("masks sk-/pk_ style keys and bearer tokens", () => {
    expect(scrubSecrets("sk_live_" + "abcdefghij1234567890ABCDEFG")).toContain("«redacted-secret»");
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")).toContain("«redacted-secret»");
  });

  it("masks a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1Niated.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36";
    expect(scrubSecrets(`token=${jwt}`)).toContain("«redacted-secret»");
  });

  it("masks AWS keys, GitHub PATs and long hex strings", () => {
    expect(scrubSecrets("AKIA" + "IOSFODNN7EXAMPLE")).toContain("«redacted-secret»");
    expect(scrubSecrets("ghp_" + "1234567890abcdefABCDEF1234567890abcd")).toContain("«redacted-secret»");
    expect(scrubSecrets("hash 0123456789abcdef0123456789abcdef")).toContain("«redacted-secret»");
  });

  it("masks PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(pem)).toBe("«redacted-secret»");
  });

  it("leaves normal page text untouched", () => {
    const text = "Welcome back, Ada. You have 5 API calls left this month. Sign out.";
    expect(scrubSecrets(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it("does not mangle ordinary short words or numbers", () => {
    expect(scrubSecrets("Order #12345 confirmed for user_account")).toBe("Order #12345 confirmed for user_account");
  });
});
