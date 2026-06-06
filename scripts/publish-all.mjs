// Publish the current build to every distribution scope — same code, same
// version, multiple names. The repo's canonical name is @trysentinel/qa; this
// swaps in each name just long enough to publish, then restores package.json
// exactly.
//
// Run via `npm run publish:all` (which gates first) or from release.yml after
// its gate steps. Idempotent: a scope already at this version is skipped, so
// re-running after a partial failure is safe. Adds --provenance only under
// GitHub Actions (where OIDC is available); locally it publishes without it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCOPES = ["@trysentinel/qa", "@run-agents/qa"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const original = readFileSync(pkgPath, "utf8"); // exact bytes — restored verbatim
const { version } = JSON.parse(original);
const provenance = process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : [];

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });

// Build the artifact once, clean and without sourcemaps. We publish with
// --ignore-scripts (prepublishOnly is bypassed), so the gate is the caller's
// job: `npm run publish:all` runs it; release.yml runs it as prior steps.
console.log(`[publish:all] clean build of ${version}…`);
rmSync(join(root, "dist"), { recursive: true, force: true });
sh("npm", ["run", "build", "--", "--sourceMap", "false"], { stdio: "inherit" });

let restored = false;
const restore = () => {
  if (!restored) {
    writeFileSync(pkgPath, original);
    restored = true;
    console.log("[publish:all] restored package.json");
  }
};
process.on("exit", restore);

try {
  for (const name of SCOPES) {
    // Already published at this version? Skip (the read API may lag, so a 409
    // below is the real backstop).
    try {
      sh("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
      console.log(`[publish:all] ${name}@${version} already published — skipping`);
      continue;
    } catch {
      /* not found → publish it */
    }

    const pkg = JSON.parse(original);
    pkg.name = name;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    console.log(`[publish:all] publishing ${name}@${version}…`);
    try {
      sh("npm", ["publish", "--ignore-scripts", "--access", "public", ...provenance], {
        stdio: "inherit",
      });
      console.log(`[publish:all] ✓ ${name}@${version}`);
    } catch (err) {
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (/cannot publish over|previously published|E409|EPUBLISHCONFLICT/i.test(out)) {
        console.log(`[publish:all] ${name}@${version} already published — skipping`);
      } else {
        throw err; // real failure (auth, network, validation) → stop
      }
    } finally {
      writeFileSync(pkgPath, original); // restore before the next scope
    }
  }
} finally {
  restore();
}
