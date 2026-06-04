# Publishing `@sentinel/qa` to npm

The package is configured and verified publish-ready. What's left is account-level
and one-time.

## Pre-flight (already done)
- [x] `name: "@sentinel/qa"`, `publishConfig.access: "public"` (required for a public scoped package)
- [x] `bin: { sentinel: ./dist/cli.js }` with a `#!/usr/bin/env node` shebang
- [x] `files` whitelist ships only `dist/` + example specs + README/ARCHITECTURE/LICENSE — **no `src/`, no tests, no source maps**
- [x] `prepublishOnly` runs `typecheck → test:ci (non-live) → clean no-map build`
- [x] Verified tarball: **163 files, ~193 kB**, CLI runs from the built bin

## You need to do (one-time)
1. **Log in to npm**: `npm login`
2. **Own the scope.** `@sentinel` may be taken — check `npm org ls sentinel`. If it isn't yours,
   create the org at npmjs.com/org/create, OR change `name` in `package.json` to a scope you own
   (e.g. `@<your-username>/qa`). One-line change.
3. **Set the real repo URL.** `package.json` `repository`/`homepage`/`bugs` and the README clone line
   are `github.com/we-building-autonomously/sentinel` placeholders.

## Publish
```bash
cd path/to/sentinel
npm publish            # prepublishOnly runs the gates + a clean build first
```

## After publish — smoke test the published artifact
```bash
npm install -g @sentinel/qa
sentinel doctor
sentinel --help
```

## Notes
- Consumers still run `npx playwright install chromium` once (the browser binary isn't in the package).
- Bump `version` per release; npm rejects re-publishing the same version.
- `npm publish --tag next` to ship a pre-release without moving `latest`.
