# Changelog

All notable changes to this project are documented here.

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
