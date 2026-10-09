# Changelog

## [2.2.0] - 2026-10-09

### Changed (behavior)

- **Batch and multi-select moves no longer guess a session id.** When the authoritative row-to-id channel (the React fiber carrying `node.id`) is unavailable, the client used to fall back to positional order and, on a title mismatch, take the *next* id in sequence. Because the official sidebar hides blank and archived rows, that fallback could shift a group by one and move a *different but valid* set of sessions — undetectable host-side. The fallback now refuses to guess: unresolvable rows are reported to the user, and a move either aborts (nothing resolvable) or proceeds with only the rows that resolved, after an explicit confirmation that names the skipped count. This is the one intentional behavior change in this release.
- **Workspace resolution verifies instead of trusting DOM order.** The positional fallback that mapped the *i*-th sidebar header to the *i*-th registry item is now accepted only when the header text actually matches that item's title or path; otherwise the move aborts with the existing "list out of sync" message. Previously a single hidden header (for example a workspace whose folder was moved) shifted every later index by one.
- **`workspace-mover` styles and dialog semantics** unchanged in appearance; dialogs gained an accessible name, initial focus, and a Tab trap.

### Added

- **`screenshots.json`**: declares the plugin's screenshots in-repository so plugin storefronts (dsh-market and peers) show them App Store style in a controlled order instead of scraping the README.
- **`peerDependencies`** for the official packages the plugin actually integrates with, each with an explicit prerelease `||` branch, plus `peerDependenciesMeta` marking the client-only ones optional. A peer range without an explicit prerelease branch silently excludes every prerelease DSH build (node-semver requires a comparator sharing the exact `major.minor.patch` tuple *and* carrying a prerelease tag), which surfaces to users as an `ERESOLVE` they have to work around by hand.
- **Storage-layout self-check.** The plugin re-implements the session-store directory encoding, and the persistence root it derives from is not a documented part of the `SessionPersistence` contract. A new read-only check reverse-derives one real session's directory from `persistence.list()` and verifies it exists; the result appears as `mover.status.capabilities.storageLayout` and as a `data-layout` check in `mover_doctor`, so a host layout change becomes a visible degraded state instead of sessions that silently cannot be found.
- **Archive-truncation visibility.** The rescue scan parses only the newest 400 session archives, and archived sessions are typically old — so on large libraries they could drop out of the archived list with no explanation. The archived view now reports when the underlying scan was truncated.
- **Client test coverage.** `test/client-dom.test.mjs` exercises the client half against a hand-rolled DOM stub (no new dependencies): workspace resolution, row-to-id mapping, the drop payload, listener teardown, dialog dismissal and the RPC failure matrix.

### Fixed

- **Client half had no teardown.** Seven document-level listeners and a `document.body` subtree `MutationObserver` were never released. The project's own hot-reload path (the desktop client disposes and recomposes the plugin fiber) could therefore stack a second copy of every listener, causing duplicate confirm dialogs, duplicate RPC calls, and two copies fighting over the same selection highlight. All listeners and the observer are now registered through the plugin context's disposal channel, and a module-level guard prevents a duplicate `apply`.
- **The menu observer no longer runs for the whole page lifetime.** It is connected after an ellipsis click and disconnected on injection or timeout, instead of observing every DOM mutation in the app forever.
- **Dead and contradictory client strings.** `ungroupedUnsupported` was never referenced. `pickEscHint` was never referenced *and* contradicted the implementation; Escape now respects the copy (it does not clear the multi-selection while a text input has focus). Two hard-coded English strings that leaked into the Chinese UI are now localized.
- **Documentation drift**: the READMEs and `docs/ARCHITECTURE.md` described three agent tools while four are registered (`mover_doctor` was missing), and the compatibility section still claimed verification against `0.1.5-rc.1` while the README badge claimed `0.2.0-rc.2`. Tool tables, the compatibility boundary, and the test-suite description are now consistent and dated.
- **Tests 108 → 141**: 10 new client DOM cases (row/workspace resolution, drag payload, listener teardown, dialog dismissal and the RPC failure matrix, against a hand-rolled DOM stub), 10 policy/Config cases, and host-side coverage for the storage-layout self-check, archive truncation, backup orphan GC, the unarchive dual path, setTitle decoupling, and the official-API capability flags.
- **Fixed a latent policy bug found while wiring the tunables**: `cleanupOldData` destructured `{ days = 30 }`, so "not supplied" became `30` and the `Number(days) || cleanupDays()` fallback could never see `undefined` — the configured cleanup age was silently shadowed by the default.

## [2.1.1] - 2026-10-05

### Added

- **`mover.doctor` self-check**: a read-only diagnostics endpoint, a "Doctor" button in the rescue panel, and a `mover_doctor` agent tool. ~13 checks cover host services (registry, persistence, projection cache, archive channel, agents, approval seam), agent-tool registration, data directories (recycle bin, backups, move history, task records), pending manual-recovery records, and workspace folder presence — each reported as pass / warn / fail with details and a summary. Intended for after DSH upgrades: see what is degraded before attempting anything else. Stays sub-second (no full scan), never mutates, and never throws — degraded hosts get fail/warn checks instead of errors.
- **Install and trust assets in the README**: the npm one-liner featured under the tagline (a `dsh://plugin/install` deep-link button was attempted and removed — GitHub's sanitizer strips custom-protocol links and rewrites the anchor to the badge image itself; enter through dsh.so for one-click install on Hub-aligned clients), a dsh.so risk badge (listed, L5 run-tested, risk low), a dsh-plugin-registry listing badge, and a "DSH tested 0.2.0-rc.2" badge.
- **Compatibility report**: `docs/compatibility/dsh-0.2.0-rc.2-2026-10-04.md` records the real desktop verification (shared data home, in-app plugin install, drag move, dialog, hot-reload fix, agent tools) and the web-profile regression status; future DSH adaptations add a dated copy each.
- **Safety Ledger**: the security-guarantees section is now branded around the backup-first pipeline (backup → stepwise rollback → post-move verification → recovery ledger) with an explicit never-does list (no git writes, no unbacked edits, no silent data loss, no unconfirmed destructive actions, no uploads — the plugin makes no network requests).
- Tests 105 → 108 (doctor all-green in sandbox, degraded-registry fail/warn behavior, recovery-record warning; agent-tool roster updated).

## [2.1.0] - 2026-10-04

### Added

- **Agent tools**: the plugin now registers three model-callable tools through the official `dsh-tools` registry — `mover_list_sessions` (read-only listing of workspace groups and sessions with their rescue statuses, for resolving a user-named group or conversation into exact ids), `mover_move_session` (moves one session through the same locked, backup-first, verified pipeline the panel uses), and `mover_repair_sessions` (one accounting-only repair pass). Tools are plain zero-dependency tool definitions; registration is skipped silently on hosts without `dsh-tools`, leaving the panel and drag flows untouched.
- **User approval for mutating tools**: `mover_move_session` and `mover_repair_sessions` request an explicit user decision through the host approval seam (`dsh-user-approval`, mounted by dsh-base) before touching anything; a denial, dismissal, or unavailable answerer fails closed with a clear message, and approval-seam errors also block the call. Cancellation propagates cooperatively into the RPC layer, which finishes any in-flight rollback before stopping.
- `mover.status` reports an `agentTools` capability flag.
- Tests 97 → 104 (tool registration and capability flag, listing composition, approval-gated move success, fail-closed outcomes for denied / cancelled / unavailable / seam-error, error-code passthrough with no approval round-trip for invalid input, repair with approval).

### Fixed

- **Opaque confirm dialog on the desktop (0.2).** The desktop theme defines `--dsw-specific-menu` as a translucent glass color, so the cross-workspace confirm card blended with the text underneath. The card now forces the themed color to full alpha via CSS relative-color syntax (browsers without support keep the previous translucent behavior).
- **Desktop (0.2) hot-reload no longer breaks moves.** The client half accessed `ctx.connection` lazily on every RPC. After the desktop app hot-reloads or recomposes its client, the plugin's old cordis fiber is disposed, and that access throws `cannot get required service "connection" in inactive context` — surfacing as a failed-move toast even though nothing was wrong with the session. The connection service instance is now captured once at apply time (while the context is active) and reused for every call; if capture is not possible, a clear "refresh the page" message replaces the internal error in both the drag toast and the rescue-panel note paths (new `contextStale` strings, zh/en).

## [2.0.3] - 2026-09-21

### Engineering

- First publish to the public npm registry as `dsh-workspace-mover` (installs via `dsh plugin --profile web add dsh-workspace-mover`).
- Local quality gate `npm run check` (syntax + tests + pack dry-run); CI runs the same steps on ubuntu / windows / macos × Node 22/24.
- README (zh/en): CI / npm version / plugin / DSH engines badges and a host compatibility matrix (`0.1.5-rc.1` / `rc.2`; `0.1.6-alpha` pending verification).
- CONTRIBUTING: release checklist keeps `package.json` version, CHANGELOG, and git tags aligned; PR template requires `npm run check`.

## [2.0.2] - 2026-09-13

- Fixed GitHub Traffic badge updates when a Gist patch would delete a file that is not present; the workflow now skips missing-file deletes and avoids HTTP 422 failures.
- Completed the architecture documentation: the RPC endpoint list and workspace projection refresh behavior now match the implementation.
- Published `.tgz` assets now include the architecture documentation and screenshots, and duplicate historical changelog entries were removed.

## [2.0.1] - 2026-09-12

- Compatible with DeepSeek Harness `0.1.5-rc.1`.
- Release downloads stay off the README until the total exceeds 10; when shown they use shields.io like the other badges instead of a gist SVG that GitHub renders as a broken text link.
- Host half waits for `webServer` before registering RPC, fixing boot failures on 0.1.5.
- Session relocation follows the highest canonical generation (`session.vN.jsonl[.zstd]`) instead of a hard-coded `session.jsonl.zstd`.
- Refuse conflicting operations through in-process session/workspace locks; no `session.lock` file is created.
- Keep full mover feature set (rescue, repoint, trash/backup, task center); official DSH still has no cross-workspace true move.

All notable changes to this project are documented here.

## [1.4.2] - 2026-09-09

### Added

- GitHub Release tags now publish a versioned `.tgz` asset and collect its download count separately from repository clones.
- The public README keeps only the observed GitHub clone metric; the Release downloads badge remains visually hidden until the total exceeds 10.

### Fixed

- Traffic history collection now consumes GitHub's `clones[]` response, upserts daily corrections, and labels the cumulative value with its observation start date.

## [1.4.1] - 2026-09-09

### Fixed

- **GitHub traffic history now uses the real `clones[]` response field.** The collector no longer mistakes the rolling 14-day aggregate for an all-time total.
- Daily clone rows are upserted by date, and the badges now distinguish observed cumulative clones from GitHub's current 14-day clone and unique-cloner window.
- Added deterministic traffic-response contract tests and migrated legacy state without presenting the old estimate as verified history.

## [1.4.0] - 2026-09-06

### Added

- **Concurrency guards (try-acquire locks)**: per-session and per-workspace keys now serialize every entry point — single move, batch move, trash delete / restore, backup restore, and workspace re-point. A second operation touching the same key never queues or deadlocks: it fails immediately with a stable `busy` code, and the client explains that the session is still being processed. Batch inputs are de-duplicated so one batch cannot race itself.
- **Stable RPC error codes**: every RPC failure now carries a machine-readable `code` — `busy / conflict / not-found / invalid-input / not-writable / insufficient-space / backup-failed / rollback-failed / corrupt-artifact / unsupported / bad-request / internal-error` — mapped at the dispatch boundary, with codes attached at the source where a message pattern would mislead (e.g. a writability-probe `EEXIST` maps to `not-writable`, not `conflict`). The client reads `error.code` first and keeps the old English-message matching only as a fallback.
- **Minimal recovery ledger**: any "rollback also failed" path (attach-rollback failure on move; manifest-write failure plus failed move-back on delete) writes a durable record to `$DSH_HOME/workspace-mover/recovery.json` (kind, phase, session, source / target, last error, time). The scan response carries `recoveryCount`, `mover.status` reports it, and the rescue panel shows a red "needs manual recovery" row — nothing is auto-deleted and the session files plus backups always remain in place.
- **Capability report**: `mover.status` now enumerates which official services it actually detected (registry, persistence, projection read/write, archive channel, coordinator states, file references, agents) plus degraded features, so support questions answer themselves.
- Input caps: session / workspace ids are validated (non-empty, ≤ 300 chars) at every entry point; data-cleanup day ranges clamp to [1, 3650].

### Fixed

- **Backup now precedes every side effect.** `moveSession` previously detached accounting before taking the byte-level backup, so a backup failure left a detached, unaccounted session behind. The pipeline now reads the source and stashes the backup first — a backup failure aborts with `backup-failed` and nothing has been touched (no accounting, no files, no indexes).
- **Scan truncation kept the wrong 400.** The 400-item scan cap was applied before the mtime sort, so very large libraries showed the oldest directory-order slice while the newest sessions could vanish from the rescue panel entirely. Metadata (stat) is now collected for everything first, sorted newest-first, and only the newest 400 get header-parsed — same parse cost, correct survivors.
- Tests 70 → 77 (backup-failure zero side effects, concurrent same-session double move → one ok / one busy, repoint-holds-lock → move busy, error-code assertions for conflict / not-writable / unsupported / not-found / invalid-input, newest-400 scan truncation, recovery-record write + recoveryCount).

## [1.3.0] - 2026-09-05

### Added

- **Data protection summary and time-based cleanup**: one combined line over the recycle bin and backups (item counts and footprint), plus a clean-older-than-30-days action — dry-run first (shows exactly how many entries and how much space would be freed), explicit confirmation, then per-item cleanup with the freed-space report. Corrupt or stale entries never block the rest.
- New RPC endpoint: `mover.data.cleanup` (with `dryRun`).
- Tests 69 → 70.

## [1.2.0] - 2026-09-05

### Added

- **Migration task center (record-style)**: every bulk move is persisted as a task — per-session state (done / failed with last error and last attempt time), source and target paths. Failed items retry in one click; each retry resolves the session's CURRENT location (never the stale recorded path), stays individually isolated, and an "already at target" failure converges to done (idempotent). Retried moves land in the move history like normal batches, so undo still works. Records are clearable without touching moved sessions.
- New RPC endpoints: `mover.tasks.list / retry / forget`. `mover.moveMany` results now include a `taskId`.
- Tests 66 → 69.

## [1.1.0] - 2026-09-05

### Added

- **Preflight completion**: moveSession preflights before touching anything — double-accounting detection (extra owners detached during the move instead of lingering as ghosts), target writability probe, advisory disk-space check. The move detaches ALL owners and the post-move single-owner pass detaches any stale remainder; rollbacks re-attach every prior owner. Results carry a `warnings` array.
- Tests 64 → 66.

## [1.0.0] - 2026-09-05

### Added

- **Post-move consistency verification**: every relocation — single move, batch move, and workspace re-point — now reads the relocated archive back and requires both the session id and the rewritten cwd to match before the move counts as done; a mismatch rolls the whole move back (destination moved back, original bytes restored) exactly like any other failure. `mover.move` results carry a `verified` flag.
- **One-click repair**: a "Fix all" action in the rescue panel runs one scan pass and automatically fixes everything fixable — misfiled sessions are homed, unregistered sessions with a matching group are attached — while anything needing a decision (orphans, damaged archives, no matching group) is skipped with a stated reason. Results report fixed / skipped / failed counts; every fix stays individually isolated and goes through the same accounting-only paths (no files are moved).
- **Panel filter**: a filter box matches title, session id, path, and group across every rescue list — orphaned, unregistered, misfiled, archived, recycle bin, and backups — with per-section shown/total counts; "Home all" acts on the currently filtered set.
- New RPC endpoint `mover.repairAll`; `verifyRelocatedArtifact` is exported for tooling.
- Tests 58 → 62 (verification helper pass/mismatch cases, verified flag on moves, repair-all mixed/empty scenarios).

## [0.9.0] - 2026-09-05

### Added

- **Session recycle bin**: the rescue panel's orphaned / unregistered / misfiled / archived rows gain a "Delete" action that moves the whole session into `$DSH_HOME/workspace-mover/recycle/` behind a manifest recording everything needed to bring it back (title, original path, owning group, archive flag, projection snapshot). Deletion clears all four traces — files, workspace accounting, registry indexes, and the projection-cache entry — so nothing lingers as a ghost or stale row. The physical move happens first: a failed delete (or a failed manifest write) rolls everything back and changes nothing. Sessions still resident in harness memory are refused with a clear message (their live objects would zombie-recreate files).
- **Restore from the recycle bin**: one click back to the original path (re-attaching accounting, re-writing the projection title, and re-entering the archived set when the session was archived), or into any other group — which routes through the full moveSession pipeline (backup, header rewrite, hot fixes, move history). If the original spot is occupied or its workspace is gone, the restore dialog opens with a target picker.
- **Purge**: single item or empty-the-bin, each behind an explicit confirmation.
- **Backup management**: every move already kept rolling byte-level backups; they are now visible — grouped per session with copy count, total size, and date span, plus the overall footprint — with one-click restore (to the backup's original location or into any group, header round-trip verified before accounting) and per-session backup deletion.
- New RPC endpoints: `mover.session.delete`, `mover.trash.list / restore / purge`, `mover.backups.list / restore / deleteOne`. Projection-cache operations degrade gracefully on hosts without the service (stale entries are harmless by design); archive-set changes skip with a warning when the registry lacks the durable state channel.
- Tests 47 → 58 (delete four-way cleanup, resident refusal, archived delete/restore symmetry, restore to original path / other group / missing workspace, purge, backup aggregation, restore with round-trip verification, per-session backup deletion).

## [0.8.1] - 2026-09-05

### Fixed

- **Directory relocation is now safe on the copy fallback.** `moveDir` previously copied the session directory file-by-file; a mid-copy failure left a partial destination directory behind, and since neither the move nor the workspace re-point wizard cleans up the target on failure, every subsequent retry was rejected with "destination artifact already exists" until files were deleted by hand — with the half-written files (already carrying the new cwd header) polluting scan results. The fallback now uses recursive `cpSync`, cleans up a half-built destination it created on failure (retry is idempotent), and refuses — without touching either side — when the destination directory already exists non-empty (unknown content is never overwritten; the error message explains that a process-interrupt leftover contains only this session's own files and can be removed by hand).
- Backup pruning matched files with `startsWith(id)`; tightened to `startsWith(id + '.')` so sessions with prefix-adjacent ids (e.g. `session-x` vs `session-x-1`) can never prune each other's backups. Same-millisecond backups of one session overwrite atomically (last-wins) without breaking the retention count.
- Tests 41 → 47 (recursive relocation, non-empty-destination refusal with both sides untouched, injected copy-failure cleanup, rename-EEXIST fallback, flow-level residual-destination recovery through `mover.move`, backup prefix isolation and same-millisecond retention).

## [0.8.0] - 2026-09-05

### Added

- **Archived session management**: the rescue panel gains an "Archived sessions" block. Sessions hidden by the official archive action — previously unreachable from any UI — are listed under their owning group (the archive set never touches workspace accounting, so ownership survives). One click restores a session to its original group, or "Restore to…" moves it into another group through the same protected move pipeline (backup, history, undo). Sessions whose real folder matches a different workspace carry a homing suggestion, so restoring and re-homing is one decision.
- **Empty group detection and cleanup**: the rescue panel lists workspaces with zero members — counted against the raw registry ledger (`record.sessionIds`), so archived and ghost roster entries always count as members and never misreport. Single delete or delete-all; each delete re-checks the raw ledger right before acting, and goes through the official workspace delete API (registration only, no session files touched).
- **"Open folder" in the workspace "…" menu**: opens the group's directory in the system file manager (explorer.exe / open / xdg-open). The RPC only accepts paths belonging to registered workspaces, and refuses missing directories.
- `mover.archived`, `mover.unarchive`, `mover.openFolder` RPC endpoints; `mover.workspaces` items now carry `rawSessionCount` (raw ledger length, including archived/ghost members, alongside the index-filtered `sessionIds`). Unarchive writes through the registry's durable state channel — the same `enqueueOperation` + `setState` path the official `archiveSession` uses — so changes survive restarts; hosts without that channel fail with a clear "unsupported on this DSH version" error.
- Tests 35 → 41 cases (archived listing + homing suggestion, unarchive with/without a target including undo round-trip, raw ledger counting, open-folder path validation and per-platform command assembly).

### Fixed

- The group-merge "deleted empty group" toast never fired: the official `workspaces.delete()` resolves with no value on success (it rejects on failure), so checking `result.ok` mislabeled every successful delete as a failure. The new empty-group cleanup uses the same corrected semantics.
- Sidebar-visible titles (official auto-naming and renames) live in the projection cache, not in the on-disk session header — so auto-titled sessions showed as "Untitled session" in the archived block and scan lists. Titles now prefer the projection cache (`storages/session_projcache.json`, read-only defensive parse) and fall back to the header.
- "Open folder" on Windows: the window opens via explorer.exe, and ~0.8s later the plugin attempts to bring it to the front via `WScript.Shell.AppActivate` on the folder title. The attempt can still be denied by Windows' foreground-lock policy depending on what has focus at the moment — the window always opens, but may occasionally need a taskbar click. (Direct explorer spawn alone always opened behind; ShellExecute-based alternatives from the harness host silently do nothing at all.)
- A session whose group was deleted ("ungrouped" with no path-matching workspace) used to offer only a permanently disabled button; it now gets the same move-into-any-group dropdown as orphaned sessions.

## [0.7.0] - 2026-08-28

### Added

- Misfiled-session detection and one-click homing: the scan now recognizes sessions whose header cwd matches an existing workspace but whose bookkeeping lives elsewhere (clone-style movers, groups recreated after folder renames, double-accounting). The rescue panel lists each as "current group → correct group" with a "Home" button plus a "Home all" batch; homing detaches every wrong owner and attaches the matching workspace without touching files on disk.
- Group merge: the workspace header's "…" menu gains a "Move whole group…" entry (injected into the official menu; the right-click interception is gone). After the move, an emptied source group can be deleted in one confirmation through the official workspace delete API.
- `mover.repair` gains the `home` action kind; `mover.scan` items now carry `homeWorkspaceId` / `homeTitle` / `homePath` / `ownerWorkspaceIds` and a `misfiled` status with matching counts.
- Tests 32 → 35 cases.

## [0.6.3] - 2026-08-28

### Fixed

- **Critical**: multi-select drag could move a session the user never picked. Row-to-id resolution previously aligned visible rows against `workspace.sessionIds` by order; hidden blank/archived members occupy slots without rows, shifting every subsequent pairing. Ids now come from the row's own React props (`SessionNodeItem` `node.id` — the same value the official dragstart writes into the drag payload), with the alignment kept only as a fallback.
- The "Recently updated" re-sort after moves never executed in the field: the v0.6.1 fiber walk found nothing and v0.6.2 called `workspaces.list()`, which does not exist on the client-side service. Membership is now derived from the order account itself plus the moved session ids, and the exact recency order is written through the official store action — verified end-to-end through the real drop pipeline.

## [0.6.2] - 2026-08-28

### Fixed

- "Recently updated" re-sort after moves is now applied through the official slot system's store instance (`ctx.slots.resolveStore` on the `sidebar.workspaces` registration) instead of walking React fibers, which silently failed in the field. When the account's timestamp cache covers every member, the plugin writes the exact correct recency order itself (replicating the official comparator); otherwise it clears the account so the official reconciliation performs a full re-sort. Flat mode and manual sort are never touched.
- Undoing a move from the settings panel now re-fetches the workspace baseline, so the session returns to its original group immediately instead of landing in "Ungrouped" until a page refresh (also applied to relink and attach).
- Starting a multi-select with Ctrl+click now automatically includes the currently open session (the one row the sidebar marks with `aria-selected`), so "open A, Ctrl+click B" selects both in one step.

## [0.6.1] - 2026-08-28

### Fixed

- Bulk moves now aggregate into a single "Recent moves" entry (with per-session sources recorded inside), and one Undo sends every session back to its own original group; sessions whose source workspace disappeared stay in the entry for a retry.
- Picking a session with a plain click now leaves multi-select automatically — no more stale "N sessions picked" badge after navigating away.
- Esc clears the multi-select even when the chat input has focus.
- The sidebar's "Recently updated" sort no longer pins freshly moved sessions to the top: the official per-workspace order account treats any unknown session as newly active and remembers the wrong order. After every move (single, batch, whole-group) and every undo, the plugin clears that workspace's account through the official store action, triggering the same full recency re-sort as manually toggling the sort option — silently, and only while "Recently updated" is the active sort (manual custom order is never touched).

## [0.6.0] - 2026-08-28

### Added

- Bulk move via multi-select drag: Ctrl/Cmd+click toggles sidebar rows, Shift+click extends within a group, Esc clears; dragging any picked row moves the whole set. Selection is built by the plugin (the sidebar has no native multi-select) with a live count badge.
- Move a whole group: the workspace header's "…" menu picks a target group and bulk-moves its accounted sessions. (Later versions moved this entry off the right-click menu to avoid clashing with the official menu.)
- New RPC endpoint `mover.moveMany`: up to 50 sessions per batch, reusing the single-move pipeline — independent per-session backup/rollback, per-item error isolation, and per-move history entries (batch results stay undoable one by one).
- Row-to-session resolution aligns each group's DOM rows with `workspace.sessionIds` order and disambiguates via `mover.scan` titles, so officially hidden blank sessions cannot shift the mapping.

## [0.5.1] - 2026-08-27

### Fixed

- Workspace titles now follow folder renames during move-home when the title still equals the old folder's basename (the official `create` default); user-chosen titles are preserved.
- Resident sessions get their frozen in-memory header swapped to the new cwd after a move, so `@` file references rebuild their search root without a harness restart.
- Stale `@` file-reference search caches rooted at the old path are disposed after every move/repoint.
- Projection-cache checkpoints have their log identity (`identity.cwd`) aligned after header rewrites, so cold starts keep serving cached projections (session titles) instead of discarding them and lazily falling back to the group name until first open.

## [0.5.0] - 2026-08-27

### Added

- Workspace health panel: settings view lists every workspace with its official status (`ok` / `missing-dir`) and raw membership count.
- Move-home wizard: redirects a stale workspace in place through the entity's unified `mutate` channel (workspace id, title, order and archive flags preserved), after pre-seeding registry indexes so the membership prune keeps everyone.
- Batch migration of all affected sessions — accounted members plus stranded orphans still on the old path — with per-file backup, automatic rollback and resident-session write-state cleanup.
- Resume support: rerun the same wizard inputs and only the remaining stragglers are processed; running sessions are skipped per-file, never pruned.
- New RPC endpoints: `mover.ws.audit`, `mover.repoint`.

### Fixed

- Ghost detection now iterates raw `record.sessionIds`; the official filtered getter hides exactly the missing-on-disk entries ghosts are.

## [0.4.0] - 2026-08-26

### Added

- Display session titles in move confirmations, repair lists, and recent move history.
- Persist the latest 100 cross-workspace moves.
- Add `mover.history` and `mover.undo` RPC endpoints.
- Add one-click undo in Settings > Session Repair.

## [0.3.2]

- Added session scanning, orphan repair, unregistered-session attachment, and rollback protection.
