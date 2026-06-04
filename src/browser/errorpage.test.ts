import { describe, it, expect } from "vitest";
import { detectErrorState, errorNote } from "./errorpage.js";

describe("detectErrorState", () => {
  it("returns null for ordinary page text", () => {
    expect(detectErrorState("Welcome back — your dashboard is ready.")).toBeNull();
    expect(detectErrorState("")).toBeNull();
  });

  it("detects server (5xx) error pages", () => {
    expect(detectErrorState("500 Internal Server Error")?.kind).toBe("http-5xx");
    expect(detectErrorState("502 Bad Gateway")?.kind).toBe("http-5xx");
    expect(detectErrorState("Service Temporarily Unavailable")?.kind).toBe("http-5xx");
    expect(detectErrorState("The server is currently unable to handle this request.")?.kind).toBe("http-5xx");
  });

  it("detects 404 / not-found pages", () => {
    expect(detectErrorState("404 — Page Not Found")?.kind).toBe("http-404");
    expect(detectErrorState("The page you're looking for doesn't exist.")?.kind).toBe("http-404");
  });

  it("detects client-side framework crashes", () => {
    expect(detectErrorState("Application error: a client-side exception has occurred")?.kind).toBe("client-exception");
    expect(detectErrorState("Unexpected Application Error")?.kind).toBe("client-exception");
    expect(detectErrorState("Uncaught TypeError: x is not a function")?.kind).toBe("client-exception");
  });

  it("detects generic 'something went wrong' crash screens", () => {
    expect(detectErrorState("We're sorry, but something went wrong.")?.kind).toBe("generic-error");
    expect(detectErrorState("Something went wrong. Please try again.")?.kind).toBe("generic-error");
    expect(detectErrorState("This page isn't working")?.kind).toBe("generic-error");
  });

  it("captures the matched phrase as evidence (capped)", () => {
    const e = detectErrorState("Oh no. Internal Server Error. Reference id 12345");
    expect(e?.evidence.toLowerCase()).toContain("internal server error");
    expect(e!.evidence.length).toBeLessThanOrEqual(120);
  });

  it("is conservative — incidental uses of 'error' do not trip it", () => {
    expect(detectErrorState("Error handling is covered in chapter 4.")).toBeNull();
    expect(detectErrorState("Enter your error budget in the SLO field.")).toBeNull();
    expect(detectErrorState("The form has an error-message component.")).toBeNull();
  });

  it("errorNote renders a banner with the verify/continue guidance only when present", () => {
    expect(errorNote("all good")).toBe("");
    const note = errorNote("500 Internal Server Error");
    expect(note).toMatch(/^⚠ ERROR PAGE \(http-5xx\)/);
    expect(note).toMatch(/done\("failure"\)/);
    expect(note).toMatch(/expected outcome, continue/);
    expect(note.endsWith("\n")).toBe(true);
  });
});
