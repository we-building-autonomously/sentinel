import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, readConfigFile, configSummary, inspectConfigFile } from "./config.js";

const KEY = "ANTHROPIC_API_KEY";
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[KEY];
  process.env[KEY] = "sk-test";
  delete process.env.SENTINEL_MODEL;
  delete process.env.SENTINEL_MAX_STEPS;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY];
  else process.env[KEY] = savedKey;
});

describe("readConfigFile", () => {
  it("returns {} when the file is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-cfg-"));
    expect(readConfigFile(dir)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads known fields but NEVER the apiKey", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-cfg-"));
    fs.writeFileSync(path.join(dir, "sentinel.config.json"), JSON.stringify({ model: "claude-x", maxSteps: 12, apiKey: "LEAK" }));
    const c = readConfigFile(dir);
    expect(c.model).toBe("claude-x");
    expect(c.maxSteps).toBe(12);
    expect((c as Record<string, unknown>).apiKey).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns {} on malformed JSON, never throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-cfg-"));
    fs.writeFileSync(path.join(dir, "sentinel.config.json"), "{not json");
    expect(readConfigFile(dir)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadConfig precedence", () => {
  it("uses the config file when env/overrides are absent", () => {
    const c = loadConfig({}, { model: "claude-file", maxSteps: 7, runsDir: "out" });
    expect(c.model).toBe("claude-file");
    expect(c.maxSteps).toBe(7);
    expect(c.runsDir).toBe("out");
  });

  it("env overrides the config file", () => {
    process.env.SENTINEL_MODEL = "claude-env";
    const c = loadConfig({}, { model: "claude-file" });
    expect(c.model).toBe("claude-env");
  });

  it("an explicit override beats both env and file", () => {
    process.env.SENTINEL_MODEL = "claude-env";
    const c = loadConfig({ model: "claude-cli" }, { model: "claude-file" });
    expect(c.model).toBe("claude-cli");
  });

  it("falls back to built-in defaults when nothing is set", () => {
    const c = loadConfig({}, {});
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.maxSteps).toBe(40);
    expect(c.runsDir).toBe("runs");
  });

  it("throws a clear error when no API key is available anywhere", () => {
    delete process.env[KEY];
    expect(() => loadConfig({}, {})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("configSummary", () => {
  it("resolves the non-secret config WITHOUT needing an API key", () => {
    delete process.env[KEY]; // no key set
    const c = configSummary({ model: "claude-file", runsDir: "out" });
    expect(c.model).toBe("claude-file");
    expect(c.runsDir).toBe("out");
    expect(c.maxSteps).toBe(40); // default
    expect(c).not.toHaveProperty("apiKey");
  });

  it("honors env over the config file", () => {
    process.env.SENTINEL_MODEL = "claude-env";
    expect(configSummary({ model: "claude-file" }).model).toBe("claude-env");
  });
});

describe("inspectConfigFile", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sn-cfgi-"));
  const write = (dir: string, content: string) => fs.writeFileSync(path.join(dir, "sentinel.config.json"), content);

  it("reports absent when there is no file", () => {
    const dir = tmp();
    expect(inspectConfigFile(dir)).toMatchObject({ present: false, valid: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports invalid on malformed JSON", () => {
    const dir = tmp();
    write(dir, "{ not json");
    const s = inspectConfigFile(dir);
    expect(s).toMatchObject({ present: true, valid: false });
    expect(s.error).toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("flags unknown keys (typos) and a stray apiKey", () => {
    const dir = tmp();
    write(dir, JSON.stringify({ model: "x", maxStpes: 5, apiKey: "LEAK" }));
    const s = inspectConfigFile(dir);
    expect(s.valid).toBe(true);
    expect(s.unknownKeys).toEqual(["maxStpes"]);
    expect(s.hasApiKey).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is clean for a valid file using only known keys", () => {
    const dir = tmp();
    write(dir, JSON.stringify({ model: "x", maxSteps: 5, runsDir: "out" }));
    expect(inspectConfigFile(dir)).toMatchObject({ present: true, valid: true, unknownKeys: [], hasApiKey: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
