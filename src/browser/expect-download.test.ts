import { describe, it, expect } from "vitest";
import { filenameMatches, evaluateDownloadExpectations, type DownloadInfo } from "./expect-download.js";

const downloads: DownloadInfo[] = [
  { filename: "report-2026.csv", content: "name,sku\nAda,sku-1\n" },
  { filename: "logo.png" }, // binary — no content read
];

describe("filenameMatches", () => {
  it("substring matches without a wildcard", () => {
    expect(filenameMatches("report-2026.csv", ".csv")).toBe(true);
    expect(filenameMatches("logo.png", ".csv")).toBe(false);
  });
  it("glob matches with *", () => {
    expect(filenameMatches("report-2026.csv", "report-*.csv")).toBe(true);
    expect(filenameMatches("invoice.pdf", "report-*.csv")).toBe(false);
  });
});

describe("evaluateDownloadExpectations", () => {
  it("is met when a download matches the filename", () => {
    expect(evaluateDownloadExpectations(downloads, [{ filename: "*.csv" }])[0].met).toBe(true);
  });

  it("is UNMET when no download matches the filename", () => {
    const [r] = evaluateDownloadExpectations(downloads, [{ filename: "invoice.pdf" }]);
    expect(r.met).toBe(false);
    expect(r.detail).toMatch(/UNMET/);
  });

  it("matches on content (verify the export payload)", () => {
    expect(evaluateDownloadExpectations(downloads, [{ filename: "*.csv", contentIncludes: "sku-1" }])[0].met).toBe(true);
    expect(evaluateDownloadExpectations(downloads, [{ filename: "*.csv", contentIncludes: "sku-999" }])[0].met).toBe(false);
  });

  it("a binary/unreadable download never satisfies a content assertion", () => {
    expect(evaluateDownloadExpectations(downloads, [{ filename: "logo.png", contentIncludes: "x" }])[0].met).toBe(false);
  });

  it("with no filename, asserts that ANY download occurred", () => {
    expect(evaluateDownloadExpectations(downloads, [{}])[0].met).toBe(true);
    expect(evaluateDownloadExpectations([], [{}])[0].met).toBe(false);
  });
});
