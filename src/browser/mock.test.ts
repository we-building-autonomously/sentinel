import { describe, it, expect } from "vitest";
import { fulfillmentFor, methodMatches, describeMock } from "./mock.js";

describe("fulfillmentFor", () => {
  it("defaults to status 200 with an empty text body", () => {
    expect(fulfillmentFor({ url: "**/x" })).toEqual({ status: 200, body: "", contentType: "text/plain" });
  });

  it("uses the json option when a json body is given", () => {
    expect(fulfillmentFor({ url: "**/items", status: 200, json: [] })).toEqual({ status: 200, json: [] });
  });

  it("passes through status, raw body and content type", () => {
    expect(fulfillmentFor({ url: "**/x", status: 500, body: "boom", contentType: "text/html" })).toEqual({
      status: 500,
      body: "boom",
      contentType: "text/html",
    });
  });

  it("prefers json over a raw body when both are present", () => {
    expect(fulfillmentFor({ url: "**/x", json: { a: 1 }, body: "ignored" })).toEqual({ status: 200, json: { a: 1 } });
  });
});

describe("methodMatches", () => {
  it("matches all methods when none is specified", () => {
    expect(methodMatches({ url: "**/x" }, "POST")).toBe(true);
  });
  it("matches the configured method case-insensitively", () => {
    expect(methodMatches({ url: "**/x", method: "get" }, "GET")).toBe(true);
    expect(methodMatches({ url: "**/x", method: "GET" }, "POST")).toBe(false);
  });
});

describe("describeMock", () => {
  it("summarizes status, body kind, method and delay", () => {
    expect(describeMock({ url: "**/api/items", method: "get", status: 500, json: {}, delayMs: 800 })).toBe(
      "GET **/api/items → HTTP 500 (JSON) after 800ms"
    );
    expect(describeMock({ url: "**/ping" })).toBe("**/ping → HTTP 200 (empty)");
  });
});
