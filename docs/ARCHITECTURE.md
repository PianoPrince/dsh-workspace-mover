# Architecture

Technical reference for contributors and advanced users. Product-facing install/usage docs live in [README.md](../README.md) / [README_EN.md](../README_EN.md). This file is the **single source of truth** for implementation details; do not duplicate it into READMEs.

## Plugin mount (DSH 0.1.5)

- Package is pure JavaScript source-as-product (no TypeScript, no build step).
- Host half mounts through a standard `insert` row in [`cordis.patch.yml`](../cordis.patch.yml).
- Client half is injected via `package.json` → `dsh.client` (`@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-ui-slots`, platform `web`).
- Official bundles are never rewritten; only event listeners and official slots are used.
- From GitHub, pnpm runs no install scripts, so `allowBuilds` is not required.

## Host / Client split

| Half | Entry | Role |
| --- | --- | --- |
| Host | `lib/index.js` | RPC, disk archives, workspace registry, backups, trash, history, locks |
| Client | `client/client.js` | Sidebar drag intercept, multi-select, confirmation UI, rescue panel (settings slot) |

Client locates rows by ARIA semantics only:

- session rows: `[aria-selected]`
- workspace title rows: `[aria-expanded]`

It never depends on CSS-module hash class names. UI uses official design tokens (`--dsw-alias-*`) for theme adaptation.

Only cross-group drops are intercepted; official same-group reorder stays untouched. After a successful move the client actively refreshes and reconciles the official workspace projection; a page reload remains the user-facing fallback.

## RPC channel

Single logical channel `/workspace-mover` via `ctx.connection.rpc.handle('/workspace-mover', …)`. No independent REST routes.

| Endpoint | Purpose |
| --- | --- |
| `mover.status` | Capability report (detected services / degraded items) plus `storageLayout`, `degradedFeatures`, and the `unarchiveApi` / `setTitleApi` flags |
| `mover.workspaces` | List workspaces |
| `mover.move` | Single-session true move |
| `mover.moveMany` | Bulk move (≤ `batchLimit`, default 50) |
| `mover.scan` | Classified rescue scan (parses the newest `scanLimit`, default 400; reports `scanned` vs `scannedParsed`) |
| `mover.repair` | Attach / relink / home one item |
| `mover.repairAll` | Batch repair (per-item isolation) |
| `mover.history` | Recent moves (≤ `historyLimit`, default 100) |
| `mover.undo` | Undo one history entry |
| `mover.ws.audit` | Workspace path health |
| `mover.repoint` | Move-home wizard |
| `mover.archived` / `mover.unarchive` | List / restore archived sessions (`mover.archived` also reports `truncated` / `scannedParsed` / `scannedTotal` / `archivedTotal`) |
| `mover.openFolder` | Open group directory in OS file manager |
| `mover.session.delete` | Session → recycle bin; optional `purgeBackups: true` also deletes that session's migration backups |
| `mover.trash.list` / `mover.trash.restore` / `mover.trash.purge` | Recycle bin; `purge` accepts optional `purgeBackups: true` |
| `mover.backups.list` / `mover.backups.restore` / `mover.backups.deleteOne` | Backup management; `list` reports `orphan` per group plus `orphanGroups` / `orphanBytes` |
| `mover.tasks.list` / `mover.tasks.retry` / `mover.tasks.forget` | Migration task center |
| `mover.data.cleanup` | Dry-run and clean aged plugin data (default age = `cleanupDays`) |

### Tunable policies

`mover.data.cleanup`'s age and the caps above come from `resolvePolicy()` in `lib/index.js`, read **at the point of use** (never frozen at module load):

| Policy | Default | Environment override |
| --- | --- | --- |
| backup retention per session | 20 | `DSH_WORKSPACE_MOVER_BACKUP_KEEP` |
| move history length | 100 | `DSH_WORKSPACE_MOVER_HISTORY_LIMIT` |
| batch cap (move / repair) | 50 | `DSH_WORKSPACE_MOVER_BATCH_LIMIT` |
| repoint cap | 200 | `DSH_WORKSPACE_MOVER_REPOINT_LIMIT` |
| rescue scan cap | 400 | `DSH_WORKSPACE_MOVER_SCAN_LIMIT` |
| cleanup age (days) | 30 | `DSH_WORKSPACE_MOVER_CLEANUP_DAYS` |

An unparseable or out-of-range value falls back to the default, so a bad configuration can never disable a feature.

### Dependency declaration, and why every peer is `*`

`package.json` declares the eight host packages this plugin integrates with as `peerDependencies`, all `*` and all `optional` in `peerDependenciesMeta`. They are **declarative metadata for storefronts**, not a compatibility gate: the plugin fail-softs at runtime and reports any real degradation through `mover.status` capabilities and `mover_doctor`. The real floor is `engines.dsh` (`>=0.1.5-rc.1`) plus `engines.node`.

This was not the first attempt. The ranges originally used the ecosystem's "explicit prerelease branch" idiom, e.g. `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`, and the host then reported the plugin as **incompatible with `0.2.0-rc.2`** — its own tested host line. The mechanism, confirmed by running dsh-market's own range evaluator:

- npm's prerelease rule is evaluated at the **comparator-set level**: one `||` alternative is one set, and a prerelease version satisfies that set only when at least one comparator in it shares the version's exact `[major, minor, patch]` tuple *and* carries a prerelease tag; only then are all comparators checked normally.
- `<0.2.0-0` does share the `0.2.0` tuple and does carry a prerelease, so the set is admitted — but `0.2.0-rc.2 > 0.2.0-0` (the `-0` sentinel sorts below every real prerelease), so the bound then excludes **every** 0.2.0 prerelease.

Enumerating release lines reproduces the fault on each new line: a `<0.3.0-0` bound breaks the moment a 0.3 prerelease ships. Hence `*`. dsh-market filters peer declarations to `/^@deepseek-ai\/dsh(?:-|$)/`, which is also why `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` were never named in the warning — they are only evaluated when `engines.dsh` mentions them, and it does not.

`test/policy.test.mjs` asserts that the declared ranges plus `engines.dsh` derive `compatible` — never `incompatible` — for DSH versions from `0.1.5-rc.1` through `1.0.0`.

**Official Config is deliberately not registered.** The schema would need `@deepseek-ai/schemastery`, which the host loader provides but which is not resolvable from this plugin's directory (verified by `createRequire` from `lib/index.js`); the npm `schemastery` has no `.volatile()` either. Because a bundle-layer static import failure breaks **boot** (a documented ecosystem failure class), `lib/config.js` never imports it — it exposes `buildConfig(z)` / `attachConfig(moduleOrBuilder)` so a host that hands over a schema builder can attach one, and exports `Config === undefined` otherwise. `buildConfig` contains all its own failures and returns `undefined` rather than throwing.

### Official-API preference is observable

v2.2 prefers two documented host APIs and keeps an equivalent fallback for each: `registry.unarchiveSession()` (fallback: `enqueueOperation` + `setState`) and `entity.setTitle()` (formerly folded into `entity.mutate`). Both fallbacks are silent by design — the feature still works — so `mover.status.capabilities` reports `unarchiveApi` / `setTitleApi` and lists `unarchive-official-api` / `set-title-official-api` in `degradedFeatures` when the host lacks them. That is what makes "which path did it take?" answerable on a real machine instead of a guess.

Errors carry stable codes (`busy`, `conflict`, `not-found`, `rollback-failed`, …). Host logs write failures under `MOVE FAILED`.

## Agent tools (DSH ≥ 0.1.5 with `dsh-tools`)

When the host provides the `tools` service, `apply()` registers four plain (zero-dependency) tool definitions; each tool's execute re-enters the internal RPC dispatch, so agent calls share the panel's locks, error codes, and transaction semantics:

| Tool | Gate | Purpose |
| --- | --- | --- |
| `mover_list_sessions` | none (read-only) | Compose scan + workspace list (sessions capped at 40, counts, ghosts, recoveryCount) for id resolution |
| `mover_move_session` | user approval | Move one session (`sessionId`, `targetWorkspaceId`, optional `sessionTitle`) |
| `mover_repair_sessions` | user approval | One `mover.repairAll` pass (accounting-only) |
| `mover_doctor` | none (read-only) | One `mover.doctor` self-check pass (host services, data dirs, recovery records, workspace paths) |

- Mutating tools call `ctx.approval.request({ agent, toolName, reason, signal })` before acting; `allowed-once` proceeds, anything else (`denied` / `cancelled` / `unavailable`) or a throwing seam fails closed. Hosts without the approval seam (no UI) rely on conversational confirmation and proceed.
- `exec.signal` propagates into the RPC layer; cancellation lets the in-flight step finish rolling back to a consistent state.
- Hosts without `dsh-tools` skip registration silently; `mover.status` reports the `agentTools` flag.

## Session archives (v3)

- Naming: `session.v3.jsonl.zstd` or `session.v3.jsonl` (highest generation wins).
- Mixed compression in one persistence root is rejected explicitly.
- True move keeps the session id and all frames; only the header `cwd` (first frame) is rewritten; other frames stay byte-identical. Publish via temp file + atomic rename.

### The storage-layout assumption, and its self-check

The whole pipeline rests on two **undocumented** assumptions: that `persistence.root` exists (`SessionPersistence`'s documented surface is `create`/`open`/`stat`/`list`), and that the on-disk directory layout equals this plugin's local port of `projectKey` / `encodeSegment`. If a host changes either, `sessionDir()` silently points at a path that does not exist — presenting as "every session is unfindable" with no diagnostic.

`verifyStorageLayout(ctx)` closes that gap: it takes up to five real headers from `persistence.list()`, reverse-derives each session's directory with this plugin's own encoding, and confirms an archive is actually there. Result states are `ok` / `degraded` / `empty` (no sessions to verify) / `unavailable`. It is exposed as `mover.status.capabilities.storageLayout` plus a `data-layout` check in `mover_doctor`, is strictly read-only, and never throws (any error degrades to a warning).

## Move pipeline

Order of operations for a cross-workspace move:

1. **Running check** — reject only mid-turn sessions (`agents.get(id)?.status === 'running'`); idle resident sessions may move.
2. **Read authority header** from disk; verify target ≠ source.
3. **Byte backup** to `$DSH_HOME/workspace-mover/backups/` (rolling `backupKeep` per session, default 20) **before any side effect** — a backup failure aborts with `backup-failed` and nothing has been touched.
4. **Preflight** — dual-accounting detect, target writability probe, disk-space hint.
5. **Rewrite first frame** (header cwd) only.
6. **Move directory** (Windows: exponential-backoff retry on EPERM; fallback copy+delete).
7. **In-memory closeout** — invalidate three registry indexes; for resident sessions clear stale persistence-coordinator write state; retarget live header `cwd` before official `attachSession`.
8. **Accounting** — source `detachSession` then target `attachSession`.
9. **Verify** — read archive back; id + cwd must match or the move fails.
10. **Rollback on any failure** — restore live header + index snapshot → original bytes back to source dir → reattach source workspace.

Concurrency: same session / same target workspace try-acquire a lock; concurrent ops return `busy` (never queue). Bulk moves de-duplicate first.

If “rollback also failed”, a durable recovery record is written and shown as a red manual-recovery row. Session files and backups stay in place — never auto-deleted.

## Workspace repoint (move-home)

Official workspace entity writes prune members using in-memory session cwd indexes. The wizard:

1. Audits path validity (`mover.ws.audit`).
2. Pre-seeds all affected sessions’ three indexes to the new path.
3. Rewrites the entity path through the unified `mutate` channel so members are not pruned.
4. Batch-migrates member sessions and strays from the old path through the same move pipeline.
5. Running sessions skip; an interrupted run resumes with only the remainder.

If `mutate` is unavailable after a host upgrade, the wizard aborts before the first file change.

## Plugin-owned data

All plugin metadata lives under `$DSH_HOME/workspace-mover/` and never overwrites official session archives in place except through the move pipeline.

| Path | Use |
| --- | --- |
| `backups/` | Byte-level pre-move backups |
| `history.json` | Last 100 cross-workspace moves |
| trash / task / recovery files | Recycle bin manifest, task center, recovery ledger |

Official session files and workspace registry are only mutated via host APIs: registry `mutate` / `attachSession` / `detachSession` and durable domain state.

## Compatibility boundary

Verified (each entry dated; the newest verification supersedes the badge claims in the READMEs):

- DeepSeek Harness `0.2.0-rc.2` (desktop, 2026-10-04) — see `docs/compatibility/dsh-0.2.0-rc.2-2026-10-04.md`
- DeepSeek Harness `0.1.5-rc.1` / `0.1.5-rc.2` (earlier release line)
- dsh-market `1.45.1`
- Node.js `≥ 22`
- `package.json` → `engines.dsh`: `>= 0.1.5-rc.1` (a lower bound only; it is deliberately not an upper bound, and dsh-market reads it for its host-requirement card)

GitHub-only packages may show “host requirement unknown” in dsh-market when no npm manifest is published; that is metadata, not runtime incompatibility.

Version-sensitive host behaviors degrade with explicit UI messages (not silent failure):

- Unarchive needs the registry durable state channel.
- Projection-cache titles parse defensively against v3; missing file falls back to archive header title.
- Host upgrades that rename registry cache fields hit the degrade path (feature still usable; ownership refresh may need a restart).

## Coexistence notes (implementation)

- CSS classes `wsm-*` and DOM attributes `data-wsm-*` are private namespaces.
- Settings panel uses the official `settings.section` slot.
- Sidebar redraw plugins that replace workspace DOM can break ARIA row lookup — features stop triggering; data is not damaged.
- Do not install a second document-level drag interceptor for cross-workspace moves.

## Client-half invariants

- **Every document-level listener and the menu `MutationObserver` is registered through the `listen()` helper and released in one `ctx.effect` teardown**, and `apply` is guarded by a module-level `applied` flag. The desktop client disposes and recomposes the plugin fiber on hot reload; without both, a second copy of every listener stacks up (duplicate confirm dialogs, duplicate RPC, two closures fighting over the same selection highlight).
- **A row is only ever mapped to a session id by a verifiable credential.** The authoritative path walks the React fiber to `memoizedProps.node.id`; the fallback aligns DOM rows to `workspace.sessionIds` by exact/longest title match. A row that cannot be confidently mapped is reported, never substituted — the previous "take the next id in order" behavior could move a different, valid session that the host cannot detect.
- **A workspace header is only mapped to a registry entity when the header text contains that entity's title or path** (or when no entity carries a display identity at all). `registry.list()` includes workspaces whose folder is gone while the sidebar hides them, so positional mapping is unsafe.
- `rowSessionId`'s fiber guard is intentionally permissive; if the official node shape changes, the fallback engages and the user is told, rather than the feature silently doing nothing.
- Dialogs are built by `injectOverlay()` and handed to `openDialog()`, which appends **before** focusing (an element not in the document cannot take focus in a browser), focuses the primary button, and traps Tab within the card.

## Tests & release

- `npm test` runs `test/core.test.mjs`, `test/e2e-sandbox.test.mjs`, `test/policy.test.mjs`, `test/client-dom.test.mjs`, `test/traffic-badge.test.mjs` and `test/release-downloads.test.mjs`. `client-dom.test.mjs` drives the **client half** against a hand-rolled DOM stub (no devDependencies, so CI keeps running plain `node --test`); `policy.test.mjs` covers the tunable-policy layer and the guarded Config builder. Exact case count is reported by the test run — do not hard-code it here beyond the release it was written for.
- Coverage includes rollback, rescue scan/repair, history undo, workspace repoint, post-move verification, recycle bin / backup restore, task center, data-protection cleanup, concurrency locks, error codes, storage-layout self-check, backup orphan GC, tunable policies, and the client half's row/workspace resolution, drag payload, listener teardown and dialog dismissal.
- Adding a test file requires listing it in `package.json` → `scripts.test`; the script enumerates files explicitly, so a new file that is not listed never runs in CI.
- CI: `.github/workflows/test.yml`.
- Release assets may ship a `.tgz` install package (`dsh-workspace-mover-*.tgz`).
- Traffic/clones and release-download badges are refreshed by `.github/workflows/traffic-badge.yml` via Gist JSON endpoints (not part of the runtime plugin).

## Related docs

- User install/usage: [README.md](../README.md), [README_EN.md](../README_EN.md)
- Full version history: [CHANGELOG.md](../CHANGELOG.md)
- Security policy: [SECURITY.md](../SECURITY.md)
