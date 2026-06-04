import { describe, it, expect } from "vitest";
import {
  urlMatches,
  requestMatches,
  evaluateRequestExpectations,
  type RequestRecord,
} from "./expect-requests.js";

const log: RequestRecord[] = [
  { method: "GET", url: "https://app.dev/api/items", status: 200 },
  { method: "POST", url: "https://app.dev/api/checkout", status: 201, body: '{"items":["sku-1"],"total":40}' },
  { method: "POST", url: "https://app.dev/api/checkout", status: 201 },
  { method: "GET", url: "https://app.dev/api/profile", status: 500 },
];

describe("urlMatches", () => {
  it("substring-matches when no wildcard is present", () => {
    expect(urlMatches("https://app.dev/api/checkout", "/api/checkout")).toBe(true);
    expect(urlMatches("https://app.dev/api/items", "/api/checkout")).toBe(false);
  });
  it("glob-matches with *", () => {
    expect(urlMatches("https://app.dev/api/checkout", "*/api/*")).toBe(true);
    expect(urlMatches("https://other.dev/x", "*/api/*")).toBe(false);
  });
});

describe("requestMatches", () => {
  it("matches on url, optional method and optional status", () => {
    const rec = log[1];
    expect(requestMatches(rec, { url: "/api/checkout" })).toBe(true);
    expect(requestMatches(rec, { url: "/api/checkout", method: "post" })).toBe(true);
    expect(requestMatches(rec, { url: "/api/checkout", method: "GET" })).toBe(false);
    expect(requestMatches(rec, { url: "/api/checkout", status: 201 })).toBe(true);
    expect(requestMatches(rec, { url: "/api/checkout", status: 200 })).toBe(false);
  });
});

describe("evaluateRequestExpectations", () => {
  it("is met when at least one request matches (default min 1)", () => {
    const [r] = evaluateRequestExpectations(log, [{ url: "/api/checkout", method: "POST" }]);
    expect(r.met).toBe(true);
    expect(r.observed).toBe(2);
  });

  it("is UNMET when the expected call never happened (the optimistic-UI bug)", () => {
    const [r] = evaluateRequestExpectations(log, [{ url: "/api/save", method: "POST" }]);
    expect(r.met).toBe(false);
    expect(r.observed).toBe(0);
    expect(r.detail).toMatch(/UNMET/);
  });

  it("honors a min count threshold", () => {
    expect(evaluateRequestExpectations(log, [{ url: "/api/checkout", min: 2 }])[0].met).toBe(true);
    expect(evaluateRequestExpectations(log, [{ url: "/api/checkout", min: 3 }])[0].met).toBe(false);
  });

  it("treats min:0 as an absence assertion (met only when zero match)", () => {
    expect(evaluateRequestExpectations(log, [{ url: "/api/delete", min: 0 }])[0].met).toBe(true);
    const present = evaluateRequestExpectations(log, [{ url: "/api/checkout", min: 0 }])[0];
    expect(present.met).toBe(false);
    expect(present.detail).toMatch(/must NOT occur/);
  });

  it("can assert a specific status (e.g. a 2xx, not the 500 we saw)", () => {
    expect(evaluateRequestExpectations(log, [{ url: "/api/profile", status: 200 }])[0].met).toBe(false);
    expect(evaluateRequestExpectations(log, [{ url: "/api/profile", status: 500 }])[0].met).toBe(true);
  });

  it("matches on a request body substring (verify the payload was sent)", () => {
    expect(evaluateRequestExpectations(log, [{ url: "/api/checkout", bodyIncludes: "sku-1" }])[0].met).toBe(true);
    const miss = evaluateRequestExpectations(log, [{ url: "/api/checkout", bodyIncludes: "sku-999" }])[0];
    expect(miss.met).toBe(false);
    expect(miss.detail).toMatch(/body~"sku-999"/);
    // A request without a captured body never satisfies a body assertion.
    expect(evaluateRequestExpectations([{ method: "POST", url: "/x", status: 200 }], [{ url: "/x", bodyIncludes: "a" }])[0].met).toBe(false);
  });
});
