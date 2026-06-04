import { describe, it, expect } from "vitest";
import { detectChallenge, challengeNote } from "./challenge.js";

describe("detectChallenge", () => {
  it("returns null for ordinary page text", () => {
    expect(detectChallenge("Welcome back. Your dashboard has 3 new items.")).toBeNull();
    expect(detectChallenge("")).toBeNull();
  });

  it("detects reCAPTCHA / hCaptcha / 'not a robot' walls", () => {
    expect(detectChallenge("Please complete the reCAPTCHA to continue")?.kind).toBe("captcha");
    expect(detectChallenge("Protected by hCaptcha")?.kind).toBe("captcha");
    expect(detectChallenge("Verify you are human")?.kind).toBe("captcha");
    expect(detectChallenge("I'm not a robot")?.kind).toBe("captcha");
  });

  it("detects 2FA / one-time-code prompts", () => {
    expect(detectChallenge("Enter the 6-digit code we sent to your phone")?.kind).toBe("2fa-otp");
    expect(detectChallenge("Two-factor authentication required")?.kind).toBe("2fa-otp");
    expect(detectChallenge("Enter your verification code")?.kind).toBe("2fa-otp");
    expect(detectChallenge("Open your authenticator app")?.kind).toBe("2fa-otp");
  });

  it("detects email/inbox verification interstitials", () => {
    expect(detectChallenge("Please verify your email to continue")?.kind).toBe("email-verification");
    expect(detectChallenge("Check your inbox for a confirmation link")?.kind).toBe("email-verification");
    expect(detectChallenge("We've sent you a verification link")?.kind).toBe("email-verification");
  });

  it("prefers the most-blocking wall when several co-occur (captcha > 2fa > email)", () => {
    const t = "Enter the code we sent to your email, then complete the reCAPTCHA";
    expect(detectChallenge(t)?.kind).toBe("captcha");
    const t2 = "Enter the verification code we emailed you. Didn't get the email?";
    expect(detectChallenge(t2)?.kind).toBe("2fa-otp");
  });

  it("carries an actionable hint that tells the agent to report blocked", () => {
    expect(detectChallenge("reCAPTCHA")?.hint).toMatch(/blocked/i);
    expect(detectChallenge("two-factor")?.hint).toMatch(/do not guess|blocked/i);
  });

  it("challengeNote renders a banner only when a challenge is present", () => {
    expect(challengeNote("nothing here")).toBe("");
    const note = challengeNote("complete the hCaptcha challenge");
    expect(note).toMatch(/^⚠ EXTERNAL CHALLENGE \(captcha\):/);
    expect(note.endsWith("\n")).toBe(true);
  });

  it("points a 2FA prompt at get_totp when a TOTP secret is configured", () => {
    const text = "Two-factor authentication required — enter your code";
    // Without a configured secret: the agent is told to block.
    expect(challengeNote(text)).toMatch(/done\(blocked\)|otherwise call done/i);
    // With a configured secret: the agent is told to fetch and type the code.
    const armed = challengeNote(text, { hasTotp: true });
    expect(armed).toMatch(/get_totp/);
    expect(armed).toMatch(/do NOT call done\(blocked\)/i);
  });

  it("does not false-positive on incidental words", () => {
    // "code" alone (a code editor, promo code) must not trip 2fa.
    expect(detectChallenge("Paste your code snippet here")).toBeNull();
    expect(detectChallenge("Apply a discount code at checkout")).toBeNull();
    // "email" alone must not trip verification.
    expect(detectChallenge("Update your email address in settings")).toBeNull();
  });
});
