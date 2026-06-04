# Contributing to Sentinel

Thanks for your interest in improving Sentinel — the browser-native QA harness.

## Development setup

Requires **Node ≥ 20**.

```bash
git clone https://github.com/we-building-autonomously/sentinel.git
cd sentinel
npm install
npx playwright install chromium    # the browser it drives
npm run build
```

## Working on the code

```bash
npm run dev -- run specs/example.todomvc.json   # run the CLI from source (tsx)
npm run typecheck                               # tsc --noEmit
npm test                                        # full vitest suite
npm run test:ci                                 # unit tests only (no live browser)
```

- **Unit tests** run without any keys and are the bar for every PR.
- **Live tests** (`*.live.test.ts`) drive a real browser and call the model — they need
  `ANTHROPIC_API_KEY` in your environment (a local `.env` works, it's gitignored). CI runs the live
  suite only on the main repo; fork PRs are gated on build + unit tests.

## Project layout

The architecture (Planner → Agent → Judge → Reporter, the ref-addressed DOM perception, etc.) is
documented in [`ARCHITECTURE.md`](ARCHITECTURE.md). Source lives in `src/`; example specs in `specs/`.

## Pull requests

1. Branch off `main`.
2. Keep changes focused; match the style of the surrounding code.
3. Add or update tests — `npm run typecheck` and `npm run test:ci` must pass.
4. Write a clear PR description of the change and why.

## Reporting bugs / ideas

Open an issue with a minimal repro (a spec or command that shows the behavior). For security issues,
do **not** open a public issue — see [`SECURITY.md`](SECURITY.md).

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
