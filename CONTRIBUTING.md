# Contributing

Thanks for contributing to `dsh-workspace-mover`.

## Development

Requirements:

- Node.js 22 or newer
- DeepSeek Harness for manual integration testing

Run the test suite:

```bash
npm test
```

> On Windows, `npm test` from a PowerShell window may be blocked by the npm.ps1 execution policy. Use Git Bash (as the CI does), or run `npm.cmd test` / `node --test test/core.test.mjs test/e2e-sandbox.test.mjs` directly.

Tests live in `test/core.test.mjs` (pure functions) and `test/e2e-sandbox.test.mjs` (end-to-end against a sandboxed fixture), run with the Node built-in test runner.

The project is dependency-free and has no build step. Keep changes focused, preserve existing DSH integration patterns, and add tests for behavior changes.

Conventions:

- Host half (`lib/index.js`): zero npm dependencies, register RPC via `connection.rpc.handle('/workspace-mover', …)`.
- Client half (`client/client.js`): source-as-product, locate UI elements by ARIA semantic attributes only — never CSS-module hash class names.
- Any move path must keep the guarantee: backup first, atomic publish, automatic rollback on failure.

## Pull Requests

- Describe the user-visible behavior and failure cases covered.
- Update `CHANGELOG.md` for user-visible changes.
- Run `npm test` and include the result.
- Do not include personal DSH data, session archives, or backup files.

## Release Discipline

1. Bump `version` in `package.json` (market update detection depends on it).
2. Tag the release (`git tag vX.Y.Z && git push origin vX.Y.Z`).
3. Never add install.ps1/install.sh at the repo root — marketplaces classify such repos as script-type plugins.
