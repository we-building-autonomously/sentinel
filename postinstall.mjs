// Best-effort: fetch the Chromium build Sentinel drives, as part of `npm install`,
// so the common case is a single command. This is intentionally non-fatal — a
// blocked or offline download must NOT fail the package install. When it is
// skipped (here, under `--ignore-scripts`, or behind a proxy), `sentinel doctor`
// and a clear runtime error both point at `npx playwright install chromium`.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

// Honour the standard Playwright opt-out plus a Sentinel-specific one.
if (
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ||
  process.env.SENTINEL_SKIP_BROWSER_DOWNLOAD
) {
  console.log("[sentinel] skipping Chromium download (env opt-out)");
  process.exit(0);
}

try {
  // Resolve Playwright's CLI from wherever npm hoisted the dependency (works for
  // both local and `-g` installs); package.json is always exports-reachable.
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  console.log("[sentinel] downloading Chromium (one-time, ~150MB)…");
  execFileSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
} catch {
  console.log(
    "[sentinel] Chromium download didn't complete — the install itself is fine.\n" +
      "           Fetch it when ready:  npx playwright install chromium"
  );
}
// Always succeed: the package is usable once the browser is present.
process.exit(0);
