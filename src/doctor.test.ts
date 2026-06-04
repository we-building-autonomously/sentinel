import { describe, it, expect } from "vitest";
import { runDoctor, summarizeDoctor, doctorExitCode, type DoctorInput } from "./doctor.js";

const base: DoctorInput = {
  nodeVersion: "v22.0.0",
  apiKey: "sk-test",
  browserPath: "/path/to/chromium",
  runsWritable: true,
};

function get(checks: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  return checks.find((c) => c.name === name)!;
}

describe("runDoctor", () => {
  it("passes a healthy environment", async () => {
    const checks = await runDoctor(base);
    expect(summarizeDoctor(checks).fail).toBe(0);
    expect(get(checks, "Node.js").status).toBe("ok");
    expect(get(checks, "Chromium").status).toBe("ok");
  });

  it("fails on an old Node version", async () => {
    const checks = await runDoctor({ ...base, nodeVersion: "v18.4.0" });
    expect(get(checks, "Node.js").status).toBe("fail");
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("warns (not fails) when the API key is missing", async () => {
    const checks = await runDoctor({ ...base, apiKey: undefined });
    expect(get(checks, "API key").status).toBe("warn");
    expect(doctorExitCode(checks)).toBe(0); // key is not a hard requirement for all commands
  });

  it("fails when Chromium is not installed", async () => {
    const checks = await runDoctor({ ...base, browserPath: null });
    expect(get(checks, "Chromium").status).toBe("fail");
    expect(get(checks, "Chromium").detail).toContain("playwright install");
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("warns when the runs dir is not writable", async () => {
    const checks = await runDoctor({ ...base, runsWritable: false });
    expect(get(checks, "Output dir").status).toBe("warn");
  });

  it("includes a reachability check only when a ping probe is given", async () => {
    const without = await runDoctor(base);
    expect(without.find((c) => c.name === "API reachable")).toBeUndefined();

    const ok = await runDoctor({ ...base, ping: async () => true });
    expect(get(ok, "API reachable").status).toBe("ok");

    const down = await runDoctor({ ...base, ping: async () => false });
    expect(get(down, "API reachable").status).toBe("warn");
  });

  it("treats a throwing ping as unreachable, not a crash", async () => {
    const checks = await runDoctor({ ...base, ping: async () => { throw new Error("dns"); } });
    expect(get(checks, "API reachable").status).toBe("warn");
  });

  it("adds a 'Browser launch' check that passes when launch succeeds", async () => {
    const checks = await runDoctor({ ...base, launch: async () => ({ ok: true }) });
    expect(get(checks, "Browser launch").status).toBe("ok");
  });

  it("FAILS the browser-launch check (with the install-deps hint) when launch errors", async () => {
    const checks = await runDoctor({
      ...base,
      launch: async () => ({ ok: false, error: "Host system is missing dependencies: libnss3\nmore lines" }),
    });
    const ch = get(checks, "Browser launch");
    expect(ch.status).toBe("fail");
    expect(ch.detail).toContain("libnss3");
    expect(ch.detail).toContain("install-deps");
    expect(ch.detail).not.toContain("more lines"); // only the first line is shown
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("treats a throwing launch probe as a failed launch, not a crash", async () => {
    const checks = await runDoctor({ ...base, launch: async () => { throw new Error("boom"); } });
    expect(get(checks, "Browser launch").status).toBe("fail");
  });

  it("skips the launch check when Chromium isn't even installed", async () => {
    const checks = await runDoctor({ ...base, browserPath: null, launch: async () => ({ ok: true }) });
    expect(checks.find((c) => c.name === "Browser launch")).toBeUndefined();
  });

  it("has no Config-file check when there is no config file", async () => {
    const checks = await runDoctor({ ...base, configFile: { present: false, valid: true, unknownKeys: [], hasApiKey: false } });
    expect(checks.find((c) => c.name === "Config file")).toBeUndefined();
  });

  it("warns on a malformed config file", async () => {
    const checks = await runDoctor({ ...base, configFile: { present: true, valid: false, unknownKeys: [], hasApiKey: false, error: "bad" } });
    expect(get(checks, "Config file").status).toBe("warn");
    expect(get(checks, "Config file").detail).toMatch(/invalid/);
  });

  it("warns on unknown config keys and a stray apiKey", async () => {
    const checks = await runDoctor({ ...base, configFile: { present: true, valid: true, unknownKeys: ["maxStpes"], hasApiKey: true } });
    const ch = get(checks, "Config file");
    expect(ch.status).toBe("warn");
    expect(ch.detail).toMatch(/maxStpes/);
    expect(ch.detail).toMatch(/apiKey is ignored/);
  });

  it("is OK for a clean config file", async () => {
    const checks = await runDoctor({ ...base, configFile: { present: true, valid: true, unknownKeys: [], hasApiKey: false } });
    expect(get(checks, "Config file").status).toBe("ok");
  });
});

describe("doctorExitCode / summarizeDoctor", () => {
  it("tallies statuses and only exits non-zero on a fail", async () => {
    const checks = await runDoctor({ ...base, apiKey: undefined, browserPath: null });
    const s = summarizeDoctor(checks);
    expect(s.warn).toBeGreaterThanOrEqual(1);
    expect(s.fail).toBeGreaterThanOrEqual(1);
    expect(doctorExitCode(checks)).toBe(1);
  });
});
