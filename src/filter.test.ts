import { describe, it, expect } from "vitest";
import { filterSpecs, parseShard, shardItems } from "./filter.js";

const specs = [
  { title: "Login works", tags: ["auth", "smoke"] },
  { title: "Checkout flow", tags: ["payment", "critical"] },
  { title: "Profile edit", tags: ["account"] },
  { title: "Logout", tags: ["auth"] },
  { title: "No tags here" },
];

describe("filterSpecs", () => {
  it("returns all specs with no filter", () => {
    expect(filterSpecs(specs)).toHaveLength(5);
  });

  it("filters by a single tag", () => {
    const out = filterSpecs(specs, { tags: ["auth"] });
    expect(out.map((s) => s.title)).toEqual(["Login works", "Logout"]);
  });

  it("treats multiple tags as OR", () => {
    const out = filterSpecs(specs, { tags: ["payment", "account"] });
    expect(out.map((s) => s.title)).toEqual(["Checkout flow", "Profile edit"]);
  });

  it("filters by title regex (case-insensitive)", () => {
    expect(filterSpecs(specs, { grep: "log" }).map((s) => s.title)).toEqual([
      "Login works",
      "Logout",
    ]);
  });

  it("combines tag and grep (AND across filter types)", () => {
    const out = filterSpecs(specs, { tags: ["auth"], grep: "out" });
    expect(out.map((s) => s.title)).toEqual(["Logout"]);
  });

  it("falls back to substring when grep is an invalid regex", () => {
    const out = filterSpecs([{ title: "a(b" }, { title: "xyz" }], { grep: "a(b" });
    expect(out.map((s) => s.title)).toEqual(["a(b"]);
  });

  it("excludes untagged specs when a tag filter is set", () => {
    expect(filterSpecs(specs, { tags: ["nope"] })).toHaveLength(0);
  });
});

describe("parseShard", () => {
  it("returns null for empty/undefined input", () => {
    expect(parseShard(undefined)).toBeNull();
    expect(parseShard("  ")).toBeNull();
  });
  it("parses a 1-based i/n spec (tolerating spaces)", () => {
    expect(parseShard("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShard(" 1 / 3 ")).toEqual({ index: 1, total: 3 });
  });
  it("rejects malformed or out-of-range values", () => {
    expect(() => parseShard("abc")).toThrow(/expected "i\/n"/);
    expect(() => parseShard("0/4")).toThrow(/between 1 and 4/);
    expect(() => parseShard("5/4")).toThrow(/between 1 and 4/);
    expect(() => parseShard("1/0")).toThrow(/total must be/);
  });
});

describe("shardItems", () => {
  const items = [0, 1, 2, 3, 4, 5, 6];
  it("returns everything with no shard", () => {
    expect(shardItems(items)).toEqual(items);
    expect(shardItems(items, null)).toEqual(items);
  });
  it("round-robins items into balanced, stable slices", () => {
    expect(shardItems(items, { index: 1, total: 3 })).toEqual([0, 3, 6]);
    expect(shardItems(items, { index: 2, total: 3 })).toEqual([1, 4]);
    expect(shardItems(items, { index: 3, total: 3 })).toEqual([2, 5]);
  });
  it("partitions with no overlap and full coverage across all shards", () => {
    const union = [1, 2, 3, 4].flatMap((i) => shardItems(items, { index: i, total: 4 }));
    expect(union.sort((a, b) => a - b)).toEqual(items);
  });
  it("a shard with no items is valid (empty)", () => {
    expect(shardItems([1, 2], { index: 3, total: 3 })).toEqual([]);
  });
});
