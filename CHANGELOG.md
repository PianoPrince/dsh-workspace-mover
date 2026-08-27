# Changelog

All notable changes to this project are documented here.

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
