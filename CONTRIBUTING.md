# Contributing

Thanks for contributing to `dsh-workspace-mover`.

## Development

Requirements:

- Node.js 22 or newer
- DeepSeek Harness for manual integration testing

Run the full local quality gate before opening a PR:

```bash
npm run check
```

This runs:

1. `npm run check:syntax` — `node --check` on host and client entry files
2. `npm test` — unit + sandbox + badge tests
3. `npm run check:pack` — `npm pack --dry-run` (publish file list sanity)

Individually:

```bash
npm test
npm run check:syntax
npm run check:pack
```

> On Windows, `npm test` from a PowerShell window may be blocked by the npm.ps1 execution policy. Use Git Bash (as the CI does), or run `npm.cmd test` / `npm.cmd run check` / `node --test test/core.test.mjs test/e2e-sandbox.test.mjs` directly.

Tests live in `test/core.test.mjs` (pure functions) and `test/e2e-sandbox.test.mjs` (end-to-end against a sandboxed fixture), plus badge workflow tests, run with the Node built-in test runner. CI (`.github/workflows/test.yml`) mirrors `check` on ubuntu/windows/macos × Node 22/24.

The project is dependency-free and has no build step. Keep changes focused, preserve existing DSH integration patterns, and add tests for behavior changes.

Conventions:

- Host half (`lib/index.js`): zero npm dependencies, register RPC via `connection.rpc.handle('/workspace-mover', …)`.
- Client half (`client/client.js`): source-as-product, locate UI elements by ARIA semantic attributes only — never CSS-module hash class names.
- Any move path must keep the guarantee: backup first, atomic publish, automatic rollback on failure.

## Pull Requests

- Describe the user-visible behavior and failure cases covered.
- Update `CHANGELOG.md` for user-visible changes.
- Run `npm run check` and include the result.
- Update the README compatibility table when DSH verification changes.
- Do not include personal DSH data, session archives, or backup files.

## Release Discipline

1. Ensure `npm run check` is green on `main`.
2. Confirm `CHANGELOG.md` matches the release notes you intend to publish.
3. Bump `version` in `package.json` (market update detection depends on it) — **keep it aligned with CHANGELOG and git tags**.
4. Tag the release (`git tag vX.Y.Z && git push origin vX.Y.Z`) using the **same** `X.Y.Z` as `package.json`.
5. Publish GitHub Release assets (`.tgz`) when cutting a user-facing version.
6. Never add install.ps1/install.sh at the repo root — marketplaces classify such repos as script-type plugins.

Semver guidance:

| Change | Version |
|--------|---------|
| Incompatible host/RPC/pipeline behavior | MAJOR |
| New user-facing capability | MINOR |
| Fixes, docs, badges, tooling | PATCH |

Verified host range (see README compatibility table) should be updated in the same PR as any host adaptation.
