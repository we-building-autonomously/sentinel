import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "./session.js";

let server: http.Server;
let base = "";
let dir = "";

beforeAll(async () => {
  server = http.createServer((_r, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Emulation</title><body>hi</body>");
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-emu-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("emulation options", () => {
  it("applies dark mode, reduced motion, locale and timezone to the page", async () => {
    const s = new BrowserSession({
      headed: false,
      artifactsDir: dir,
      colorScheme: "dark",
      reducedMotion: "reduce",
      locale: "fr-FR",
      timezoneId: "Asia/Tokyo",
    });
    await s.start();
    await s.goto(base);
    const env = await s.page.evaluate(() => ({
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    await s.close();

    expect(env.dark).toBe(true);
    expect(env.reduced).toBe(true);
    expect(env.language).toBe("fr-FR");
    expect(env.timezone).toBe("Asia/Tokyo");
  }, 30_000);

  it("defaults to light / no emulation when unset", async () => {
    const s = new BrowserSession({ headed: false, artifactsDir: dir });
    await s.start();
    await s.goto(base);
    const dark = await s.page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await s.close();
    expect(dark).toBe(false);
  }, 30_000);
});
