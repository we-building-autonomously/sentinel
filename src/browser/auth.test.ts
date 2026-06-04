import { describe, it, expect } from "vitest";
import { detectAuthFailure, authFailureNote } from "./auth.js";

describe("detectAuthFailure", () => {
  it("returns false for ordinary page text", () => {
    expect(detectAuthFailure("Welcome back — your dashboard is ready.")).toBe(false);
    expect(detectAuthFailure("")).toBe(false);
  });

  it("detects common credential-rejection messages", () => {
    expect(detectAuthFailure("Invalid credentials")).toBe(true);
    expect(detectAuthFailure("Incorrect password. Please try again.")).toBe(true);
    expect(detectAuthFailure("The password you entered is incorrect")).toBe(true);
    expect(detectAuthFailure("Wrong username or password")).toBe(true);
    expect(detectAuthFailure("These credentials do not match our records.")).toBe(true);
    expect(detectAuthFailure("Login failed")).toBe(true);
    expect(detectAuthFailure("Sign-in unsuccessful")).toBe(true);
    expect(detectAuthFailure("We couldn't sign you in")).toBe(true);
    expect(detectAuthFailure("Email or password is incorrect")).toBe(true);
    expect(detectAuthFailure("Account not found")).toBe(true);
  });

  it("is conservative — ordinary form validation does NOT trip it", () => {
    expect(detectAuthFailure("Please enter a valid email address")).toBe(false);
    expect(detectAuthFailure("Password must be at least 8 characters")).toBe(false);
    expect(detectAuthFailure("Choose a strong password")).toBe(false);
    expect(detectAuthFailure("Your account is now active")).toBe(false);
  });

  it("authFailureNote renders an actionable banner only when present", () => {
    expect(authFailureNote("all good")).toBe("");
    const note = authFailureNote("Invalid credentials");
    expect(note).toMatch(/^⚠ LOGIN appears to have FAILED/);
    expect(note).toMatch(/done\('blocked'\)/);
    expect(note).toMatch(/expected outcome — continue/);
    expect(note.endsWith("\n")).toBe(true);
  });
});
