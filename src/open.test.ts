import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findLatestReport, openerFor } from "./open.js";

let runs: string;
beforeEach(() => {
  runs = fs.mkdtempSync(path.join(os.tmpdir(), "sn-open-"));
});
afterEach(() => fs.rmSync(runs, { recursive: true, force: true }));

function writeReport(name: string, file: "report.html" | "index.html", mtime: number) {
  const dir = path.join(runs, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, "<html></html>");
  fs.utimesSync(p, new Date(mtime), new Date(mtime));
}

describe("findLatestReport", () => {
  it("returns null when there are no reports", () => {
    expect(findLatestReport(runs)).toBeNull();
    expect(findLatestReport(path.join(runs, "missing"))).toBeNull();
  });

  it("returns the most recently modified report across runs", () => {
    writeReport("a", "report.html", Date.now() - 10_000);
    writeReport("suite-1", "index.html", Date.now()); // newest
    writeReport("b", "report.html", Date.now() - 5_000);
    expect(findLatestReport(runs)).toBe(path.join(runs, "suite-1", "index.html"));
  });
});

describe("openerFor", () => {
  it("maps platforms to the right opener", () => {
    expect(openerFor("darwin")).toBe("open");
    expect(openerFor("win32")).toBe("start");
    expect(openerFor("linux")).toBe("xdg-open");
  });
});
