import { describe, it, expect } from "vitest";
import { evaluateStateExpectations, type StateSnapshot } from "./expect-state.js";

const snap: StateSnapshot = {
  cookies: { session: "abc123", cookie_consent: "accepted" },
  localStorage: { theme: "dark", auth_token: "eyJ.signed.jwt" },
  sessionStorage: { wizardStep: "3" },
};

describe("evaluateStateExpectations", () => {
  it("is empty when nothing is declared", () => {
    expect(evaluateStateExpectations(snap, undefined)).toEqual([]);
    expect(evaluateStateExpectations(snap, [])).toEqual([]);
  });

  it("present check: met when the key exists, unmet otherwise", () => {
    const r = evaluateStateExpectations(snap, [
      { scope: "localStorage", key: "auth_token" },
      { scope: "localStorage", key: "missing" },
    ]);
    expect(r[0]).toMatchObject({ present: true, met: true });
    expect(r[1]).toMatchObject({ present: false, met: false });
  });

  it("value check: met only when the stored value contains the substring", () => {
    const r = evaluateStateExpectations(snap, [
      { scope: "localStorage", key: "theme", value: "dark" },
      { scope: "cookie", key: "cookie_consent", value: "accepted" },
      { scope: "localStorage", key: "theme", value: "light" },
      { scope: "cookie", key: "missing", value: "x" },
    ]);
    expect(r[0].met).toBe(true);
    expect(r[1].met).toBe(true);
    expect(r[2]).toMatchObject({ met: false, present: true });
    expect(r[3]).toMatchObject({ met: false, present: false }); // absent key with a value want
    expect(r[3].detail).toMatch(/key absent/);
  });

  it("absent check: met when the key is gone (e.g. logout cleared the session)", () => {
    const r = evaluateStateExpectations(snap, [
      { scope: "cookie", key: "session", absent: true }, // still present → unmet
      { scope: "cookie", key: "old_session", absent: true }, // gone → met
    ]);
    expect(r[0]).toMatchObject({ met: false, present: true });
    expect(r[1]).toMatchObject({ met: true, present: false });
  });

  it("absent takes precedence over a value (value ignored)", () => {
    const r = evaluateStateExpectations(snap, [{ scope: "cookie", key: "session", value: "abc", absent: true }]);
    expect(r[0].met).toBe(false); // present, so absent assertion fails regardless of value
  });

  it("reads the right store per scope and is case-sensitive on values", () => {
    expect(evaluateStateExpectations(snap, [{ scope: "sessionStorage", key: "wizardStep", value: "3" }])[0].met).toBe(true);
    // a localStorage key is not found under cookies
    expect(evaluateStateExpectations(snap, [{ scope: "cookie", key: "theme" }])[0].met).toBe(false);
    expect(evaluateStateExpectations(snap, [{ scope: "localStorage", key: "theme", value: "DARK" }])[0].met).toBe(false);
  });

  it("an empty-string value is treated as a plain presence check", () => {
    expect(evaluateStateExpectations(snap, [{ scope: "localStorage", key: "theme", value: "" }])[0].met).toBe(true);
  });
});
