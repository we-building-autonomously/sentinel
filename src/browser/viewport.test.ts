import { describe, it, expect } from "vitest";
import { resolveViewport } from "./viewport.js";

describe("resolveViewport", () => {
  it("defaults to desktop when unset or unrecognized", () => {
    expect(resolveViewport(undefined).label).toBe("desktop");
    expect(resolveViewport("nonsense-device").label).toBe("desktop");
    expect(resolveViewport(undefined).viewport).toEqual({ width: 1280, height: 800 });
  });

  it("maps named presets with mobile/touch capabilities", () => {
    const mobile = resolveViewport("mobile");
    expect(mobile.viewport.width).toBe(390);
    expect(mobile.isMobile).toBe(true);
    expect(mobile.hasTouch).toBe(true);

    const tablet = resolveViewport("tablet");
    expect(tablet.hasTouch).toBe(true);
    expect(tablet.isMobile).toBeUndefined();
  });

  it("is case-insensitive for presets", () => {
    expect(resolveViewport("Mobile").label).toBe("mobile");
  });

  it("passes through an explicit { width, height }", () => {
    const v = resolveViewport({ width: 1024, height: 768 });
    expect(v.viewport).toEqual({ width: 1024, height: 768 });
    expect(v.label).toBe("1024×768");
  });

  it("parses a WIDTHxHEIGHT string", () => {
    expect(resolveViewport("900x600").viewport).toEqual({ width: 900, height: 600 });
    expect(resolveViewport("900X600").label).toBe("900×600");
  });

  it("resolves a Playwright device name with its user agent + scale factor", () => {
    const v = resolveViewport("iPhone 13");
    expect(v.label).toBe("iPhone 13");
    expect(v.viewport.width).toBeGreaterThan(0);
    expect(v.userAgent).toMatch(/iPhone/i);
    expect(v.hasTouch).toBe(true);
  });
});
