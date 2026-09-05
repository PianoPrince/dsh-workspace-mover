# Changelog

All notable changes to this project are documented here.

## [0.9.0] - 2026-09-05

### Added

- **Session recycle bin**: the rescue panel's orphaned / unregistered / misfiled / archived rows gain a "Delete" action that moves the whole session into `$DSH_HOME/workspace-mover/recycle/` behind a manifest recording everything needed to bring it back (title, original path, owning group, archive flag, projection snapshot). Deletion clears all four traces — files, workspace accounting, registry indexes, and the projection-cache entry — so nothing lingers as a ghost or stale row. Sessions still resident in harness memory are refused with a clear message (their live objects would zombie-recreate files).
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
