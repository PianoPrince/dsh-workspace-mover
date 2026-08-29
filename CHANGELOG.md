# Changelog

All notable changes to this project are documented here.

## [0.7.0] - 2026-08-28

### Added

- Misfiled-session detection and one-click homing: the scan now recognizes sessions whose header cwd matches an existing workspace but whose bookkeeping lives elsewhere (clone-style movers, groups recreated after folder renames, double-accounting). The rescue panel lists each as "current group → correct group" with a "Home" button plus a "Home all" batch; homing detaches every wrong owner and attaches the matching workspace without touching files on disk.
- Group merge: after a whole-group move via the workspace-header context menu, the plugin checks the source group and offers to delete it once it is empty — a merge in two commands, through the official workspace delete API.
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
- Move a whole group: right-click a workspace header to pick a target group and bulk-move its accounted sessions.
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
