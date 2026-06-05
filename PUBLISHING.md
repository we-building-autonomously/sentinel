# Releasing `@trysentinel/qa`

Releases are published to npm **by CI** (`.github/workflows/release.yml`) when you publish a GitHub
Release — gated on typecheck + unit tests + a clean build, so a broken build can never reach npm.

---

## One-time setup

### 1. npm account + scope
- Create an npm account, verify email, **enable 2FA**.
- Own the **`@sentinel`** scope: create the org at npmjs.com/org/create (free for public packages), or
  change `name` in `package.json` to a scope you own (e.g. `@<username>/qa`).

### 2. First publish (manual, once)
Trusted publishing needs the package to exist first. Publish `0.1.0` by hand once:
```bash
npm login
npm publish        # publishConfig.access:"public" + prepublishOnly gates run automatically
```

### 3. Wire CI publishing (so future releases are automated)
Pick one:

**A. Trusted publishing via OIDC (recommended — no token).**
On npmjs.com → the `@trysentinel/qa` package → **Settings → Publishing access → Trusted Publisher** → add:
- Repository: `we-building-autonomously/sentinel`
- Workflow: `release.yml`

That's it — `release.yml` already requests `id-token: write` and runs `npm publish --provenance`.
You get build provenance (the "Published from CI" badge) for free.

**B. Token fallback.** Create an npm **Automation** (or granular) access token → add it as a GitHub
**repository secret** named `NPM_TOKEN`. `release.yml` uses it automatically.

### 4. Branch protection — the rules to add
GitHub → **Settings → Rules → Rulesets → New branch ruleset**, target branch `main`:

- ✅ **Require a pull request before merging** (1 approval; solo maintainers can set 0 and just require the PR)
- ✅ **Require status checks to pass** → add the **`test`** check (from `ci.yml`); ✅ *Require branches to be up to date*
- ✅ **Block force pushes**
- ✅ **Restrict deletions**
- (optional) Require linear history · Require signed commits

This guarantees nothing merges to `main` unless CI (typecheck + build + unit tests) is green — and since
releases are cut from `main`, **only tested code can be published**.

### 5. Enable secret scanning (recommended)
Settings → **Code security** → enable **Secret scanning** + **Push protection**.

---

## Cutting a release

1. **Bump the version** in `package.json` (e.g. `0.1.0` → `0.2.0`) via a PR — CI must pass to merge.
2. **Create a GitHub Release** with a tag that matches: `v0.2.0`.
3. `release.yml` runs the gate (typecheck → tests → build → *version-matches-tag* check) and publishes.
4. Verify: `npm view @trysentinel/qa version`.

> The `vX.Y.Z` tag must equal `package.json` version — the workflow fails the release if they differ.

---

## What's already configured
- `package.json`: `@trysentinel/qa`, `publishConfig.access:"public"`, `prepublishOnly` (typecheck → test:ci → clean no-map build), `files` whitelist (no `src`/tests/maps).
- `.github/workflows/ci.yml` — the PR gate (the required status check).
- `.github/workflows/release.yml` — gated npm publish on Release.
- `.github/workflows/sentinel.yml` — the live browser E2E suite (main + manual only; needs `ANTHROPIC_API_KEY` secret).

## End-user install (for the README)
```bash
npm install -g @trysentinel/qa
npx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...
```
