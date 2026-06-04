# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR.

Email **security@your-domain.dev** (or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)).
We'll acknowledge within a few business days and keep you updated through to a fix.

## Scope notes

Sentinel drives a real browser against apps you point it at and may handle sensitive inputs:

- **Credentials** you provide (`app.auth`, env-templated passwords) are used only to drive the run and
  are never written to reports — see the secret-scrubbing in `src/report/secrets.ts`.
- **Reports** (screenshots, traces, JSON/MD/HTML) are redacted before being written, but treat run
  artifacts as potentially sensitive and store them accordingly.
- Sentinel executes against URLs you specify; only run it against apps you're authorized to test.

## Supported versions

Fixes land on the latest `0.x` release. Pin a version if you need stability, and upgrade for security
fixes.
