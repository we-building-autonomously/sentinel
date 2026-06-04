import { describe, it, expect } from "vitest";
import { totp, base32Decode } from "./totp.js";

// RFC 6238 reference key is the 20-byte ASCII string "12345678901234567890";
// its standard base32 encoding is the secret below.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32Decode", () => {
  it("round-trips the RFC key", () => {
    expect(base32Decode("GEZDGNBVGY3TQOJQ").toString("ascii")).toBe("1234567890");
    expect(base32Decode(RFC_SECRET).toString("ascii")).toBe("12345678901234567890");
  });
  it("tolerates lowercase, spaces and padding", () => {
    expect(base32Decode("gezd gnbv gy3t qojq").toString("ascii")).toBe("1234567890");
    expect(base32Decode("GEZDGNBVGY3TQOJQ====").toString("ascii")).toBe("1234567890");
  });
});

describe("totp (RFC 6238 SHA1 vectors, 6-digit)", () => {
  const cases: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [time, code] of cases) {
    it(`T=${time} → ${code}`, () => {
      expect(totp(RFC_SECRET, { time })).toBe(code);
    });
  }

  it("honours an 8-digit override", () => {
    expect(totp(RFC_SECRET, { time: 59, digits: 8 })).toBe("94287082");
  });

  it("is stable within a 30s step and changes across the boundary", () => {
    expect(totp(RFC_SECRET, { time: 30 })).toBe(totp(RFC_SECRET, { time: 59 }));
    expect(totp(RFC_SECRET, { time: 60 })).not.toBe(totp(RFC_SECRET, { time: 59 }));
  });
});
