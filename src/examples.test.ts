import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateSpecData } from "./validate.js";
import { makeContext } from "./template.js";

// Resolve specs/ relative to the repo root (this file lives in src/).
const SPECS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "specs");

function load(file: string): unknown {
  const raw = fs.readFileSync(path.join(SPECS_DIR, file), "utf8");
  return /\.ya?ml$/i.test(file) ? parseYaml(raw) : JSON.parse(raw);
}

const specFiles = fs.existsSync(SPECS_DIR)
  ? fs.readdirSync(SPECS_DIR).filter((f) => /\.(ya?ml|json)$/i.test(f))
  : [];

// Deterministic context so {{randomEmail}} etc. resolve during validation.
const ctx = makeContext({ now: 1, rand: () => 0.5, env: { APP_URL: "https://app.test" } });

describe("shipped example specs", () => {
  it("there are example specs to validate", () => {
    expect(specFiles.length).toBeGreaterThan(0);
  });

  // Every example must stay schema-valid AND typo-free — the examples are the
  // first thing a user copies, so they can't be allowed to rot.
  for (const file of specFiles) {
    it(`${file} is valid with no unknown-field warnings`, () => {
      const res = validateSpecData(load(file), ctx);
      expect(res.errors, `${file}: ${res.errors.join("; ")}`).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.warnings, `${file}: ${res.warnings.join("; ")}`).toEqual([]);
    });
  }
});
