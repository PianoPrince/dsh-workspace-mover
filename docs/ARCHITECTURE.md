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
| `mover.preview` | Read-only migration preview: source/target, collision, running state, adapter and estimated new snapshot bytes; `backup.reused` identifies an existing matching snapshot |
| `mover.moveMany` | Bulk move (≤ `batchLimit`, default 50) |
| `mover.scan` | Classified rescue scan (parses the newest `scanLimit`, default 400; reports `scanned` vs `scannedParsed`) |
| `mover.repair` | Attach / relink / home one item |
| `mover.repairAll` | Batch repair (per-item isolation) |
| `mover.history` | Recent moves (≤ `historyLimit`, default 100) |
| `mover.undo` | Undo one history entry |
| `mover.ws.audit` | Workspace path health |
| `mover.ws.create` | Register a new workspace (`name`, `directory`) over an existing folder; `conflict` when the name or the folder is already in use |
| `mover.ws.rename` | Rename one workspace (`workspaceId`, `name`, optional `dryRun`); display title only, `conflict` on a name another workspace holds |
| `mover.repoint` | Move-home wizard |
| `mover.archived` / `mover.unarchive` | List / restore archived sessions (`mover.archived` also reports `truncated` / `scannedParsed` / `scannedTotal` / `archivedTotal`) |
| `mover.openFolder` | Open group directory in OS file manager |
| `mover.session.delete` | Session → recycle bin; optional `purgeBackups: true` also deletes that session's migration backups |
| `mover.trash.list` / `mover.trash.restore` / `mover.trash.purge` | Recycle bin; `purge` accepts optional `purgeBackups: true` |
| `mover.backups.list` / `mover.backups.restore` / `mover.backups.deleteOne` | Recovery-snapshot management; `list` reports `orphan` per group, physical `count`, plus `orphanGroups` / `orphanBytes` |
| `mover.tasks.list` / `mover.tasks.retry` / `mover.tasks.forget` | Migration task center |
| `mover.migrations.enqueue` / `mover.migrations.list` / `mover.migrations.retry` / `mover.migrations.cancel` | Persistent busy-session queue; `retry` accepts one `taskId` or a `taskIds` batch, with per-item failure isolation |
| `mover.bundle.export` / `mover.bundle.inspect` / `mover.bundle.import` | Portable Bundle export, dry-run inspection, and import through the adapter/backup pipeline |
| `mover.data.cleanup` | Dry-run and clean aged plugin data (default age = `cleanupDays`) |

### Tunable policies

`mover.data.cleanup`'s age and the caps above come from `resolvePolicy()` in `lib/index.js`, read **at the point of use** (never frozen at module load):

| Policy | Default | Environment override |
| --- | --- | --- |
| physical snapshot retention per session | 20 | `DSH_WORKSPACE_MOVER_BACKUP_KEEP` |
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

When the host provides the `tools` service, `apply()` registers six plain (zero-dependency) tool definitions; each tool's execute re-enters the internal RPC dispatch, so agent calls share the panel's locks, error codes, and transaction semantics:

| Tool | Gate | Purpose |
| --- | --- | --- |
| `mover_list_sessions` | none (read-only) | Compose scan + workspace list (sessions capped at 40, counts, ghosts, recoveryCount) for id resolution |
| `mover_move_session` | user approval | Move one session (`sessionId`, `targetWorkspaceId`, optional `sessionTitle`) |
| `mover_repair_sessions` | user approval | One `mover.repairAll` pass (accounting-only) |
| `mover_doctor` | none (read-only) | One `mover.doctor` self-check pass (host services, data dirs, recovery records, workspace paths) |
| `mover_create_workspace` | none | Register a workspace (`name`, `directory`) through `mover.ws.create` |
| `mover_rename_workspace` | user approval unless full access | Rename a workspace (`workspaceId`, `name`) through `mover.ws.rename` |

- Mutating tools call `approval.request({ agent, toolName, callId, reason, signal })` before acting; `allowed-once` proceeds, anything else (`denied` / `cancelled` / `unavailable`) or a throwing seam fails closed. Hosts without an approval seam refuse operations requiring approval and direct the user to the rescue panel. `callId` is the tool call's own id. The ACP answerer delegates any request without one, so ACP sessions could never approve before it was passed, and the Web prompt uses it to attach to the tool call it already shows.
- `mover_rename_workspace` skips the prompt when the calling session's effective sandbox mode, read from `ctx.sandboxPolicy.resolve({ session })`, is `danger-full-access` — the same test the official `plugin_manager` tool uses. The bypass is required, not only convenient: the shipped `danger-full-access` preset pairs that mode with approval policy `never`, under which every request resolves `rejected`. A missing policy service or a throwing `resolve` counts as *not* full access, so the tool asks. The tool validates through `dryRun` first, so an unknown id, a blank name, or a name conflict fails before the user is asked; renaming to the current title is a no-op that never prompts. The commit re-validates inside the serialized naming queue, so a conflict created while the prompt was open is still rejected. `mover_doctor` reports whether full-access detection is available under `host-sandbox-policy`.
- `mover_create_workspace` is ungated because it only adds a registry entry for an existing folder: it never creates folders or files, and a directory already used by a workspace is rejected. "Same folder" uses the host's own identity. The official `registry.create()` canonicalizes with `realpath` and returns the *existing* entity for an owned path, so a trailing slash, `..`, or a symlink alias counts as the same folder. The plugin treats "returned an entity that existed before the call" as `conflict` instead of re-implementing path comparison.
- Workspace names must be unique (exact match after trimming) for both create and rename. The host registry allows duplicate titles, but the official rename dialog refuses them; the plugin applies that rule to both tools. Check and write run in one serialized queue so two calls cannot claim the same name.
- `exec.signal` propagates into the RPC layer; cancellation lets the in-flight step finish rolling back to a consistent state.
- Hosts without `dsh-tools` skip registration silently; `mover.status` reports the `agentTools` flag.
- **Only `workspaceRegistry` and `sessionPersistence` are in `inject`.** Cordis treats every `inject` entry as required: a missing one leaves the whole plugin fiber inactive, which removes the rescue panel's RPC channel along with every tool. `tools` and `approval` were listed until 2.3.x, so a host without `dsh-user-approval` lost the plugin entirely, and the old missing-approval branch could never run. Now the tools register inside a nested `ctx.inject(['tools'], …)`, so they appear and disappear with `dsh-tools` and the `agentTools` flag follows. Missing approval now blocks operations that require confirmation. The approval service is read with `ctx.get('approval')` on each call, so installing or removing `dsh-user-approval` takes effect without re-mounting the plugin.

## Session archives and storage adapter

- The fallback filesystem adapter recognizes names `session.jsonl[.zstd]` and `session.vN.jsonl[.zstd]`; it selects the highest generation without rewriting older files to v3.
- A mixed plain/Zstd directory and a file whose compression differs from the host's configured mode are rejected explicitly. Mixed compression elsewhere under the same root is diagnosed per session, not by a root-wide scan.
- v3/v4 filenames are recognized, but a v4 runtime fixture has not yet been verified. Filename/header mismatch is rejected only when the header contains one of the generation fields currently recognized by the adapter.
- True move keeps the session id and all frames; only the header `cwd` (first frame) is rewritten; other frames stay byte-identical. Publish via temp file + atomic rename.

### The storage-layout assumption, and its self-check

The adapter first reports the public `list` / `stat` / `open` surface. When a provider also exposes a physical root, the plugin uses the legacy directory adapter as a visible `filesystem-fallback`; when only official handles are available it stays read/diagnostic capable and marks physical moves as `unsupported` instead of guessing a path.

`verifyStorageLayout(ctx)` closes that gap: it takes up to five real headers from `persistence.list()`, reverse-derives each session's directory with this plugin's own encoding, and confirms an archive is actually there. Result states are `ok` / `degraded` / `empty` (no sessions to verify) / `unavailable`. It is exposed as `mover.status.capabilities.storageLayout` plus a `data-layout` check in `mover_doctor`, is strictly read-only, and never throws (any error degrades to a warning).

`mover.status.capabilities.storageAdapter` is `filesystem-fallback`, `official-handle`, or `unavailable`; `storageApi`, `physicalPath`, and `migrationQueueState` expose the exact degradation and queue state. `mover_doctor` reports the same adapter under `storage-adapter` and checks the durable migration records under `data-migrations`.

Portable Bundles contain `manifest.json`, `sessions/`, `attachments/`, `checksums.json`, and `workspace-metadata.json`. Import defaults to dry-run and reports id conflicts, missing attachments, compression incompatibilities, required/free space, and recoverable files. Execution refuses a blocked plan, backs up each artifact, verifies the rewritten header, and isolates failures per session. Attachment files are preserved and copied into the imported session directory; the bundle report calls out any missing file.

## Move pipeline

Order of operations for a cross-workspace move:

1. **Running check** — queue running or resident sessions; a resident backend writer cannot be safely rebound through the current public API. Await backend `flush()` when available, then recheck residency before reading the archive.
2. **Read authority header** from disk; verify target ≠ source.
3. **Recovery snapshot** to `$DSH_HOME/workspace-mover/backups/` (up to `backupKeep` distinct physical files per session, default 20) **before any side effect**. The content fingerprint ignores the migration-only header `cwd`, so a move back and forth reuses the existing snapshot. A backup failure aborts with `backup-failed` and nothing has been touched.
4. **Preflight** — dual-accounting detect, target writability probe, disk-space hint.
5. **Rewrite header cwd**; if an existing `working-directory/change` would override it, append a new event with the next contiguous sequence number. Preserve original events. Reject unsupported generations or invalid sequences before detach.
6. **Move directory** (Windows: exponential-backoff retry on EPERM; fallback copy+delete).
7. **In-memory closeout** — invalidate three registry indexes before official `attachSession`; never change private writer state or live session headers. Clear the cached `workingDirectory` row so it rebuilds from the migrated log.
8. **Accounting** — source `detachSession` then target `attachSession`.
9. **Verify** — read archive back; id + cwd must match or the move fails.
10. **Rollback on any failure** — restore original bytes back to source dir and reattach the source workspace.

Concurrency: same session / same target workspace try-acquire a lock. A running or resident session returns `busy` to the transaction layer and is persisted in `migrations.json` as `waiting-for-idle`; the queue wakes every few seconds and on the next plugin start. Idle alone does not release a resident writer: wait for unloading or restart. Workspace repoint checks residency before changing the workspace path. Bulk moves de-duplicate first and isolate each result.

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
| `backups/` | Byte-level recovery snapshots; new files include a SHA-256 content fingerprint, while legacy timestamp-only names remain readable |
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

Backup restore derives the filename generation from the official header `version` (legacy headers without a generation use `session.jsonl`); it never defaults v4 content to a v3 filename. Portable Bundle manifests read the plugin version from `package.json`.
