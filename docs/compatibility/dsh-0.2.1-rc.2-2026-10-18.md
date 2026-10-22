# 2026-10-18 compatibility fixes (unreleased)

- Plugin baseline: 2.3.0; package version unchanged. No GitHub push or npm publication.
- Source review: official DSH `dsh-v0.2.1-rc.2`; compared JSONL writer lifecycle with `dsh-v0.2.0-rc.2`.
- Environment: Windows, Node v22.23.2 local sandbox. Desktop/Web runtime acceptance is pending.
- Fixtures: constructed JSONL records using the official v4 header `version` and event envelope (`type`, `seq`, `time`, `data`). These are sandbox fixtures, not a captured official runtime session.

## Changed behavior

1. Resident sessions, including idle sessions, wait for unloading before physical migration. Current DSH exposes no public writer rebind API. The plugin no longer replaces live headers or clears private coordinator state. Workspace repoint refuses resident sessions before changing the registry path.
2. Cold migration awaits backend `flush()` when available, then checks residency and running state again. A flush failure aborts before backup/detach.
3. Migration sets the effective working directory to the target workspace. Original working-directory events remain intact; a final `working-directory/change` is appended when needed. Its sequence must follow a contiguous v3/v4 log. Unrecognized formats or invalid sequences abort before detach. The working-directory checkpoint is invalidated so replay sees the new directory.
4. Backup restore uses the official header version for v3/v4 filenames. Headers without generation metadata restore as unversioned legacy JSONL. Plain and Zstd are both covered.
5. Bundle manifests take `pluginVersion` from package.json.

Working-directory events are actual log changes, so sessions with such changes can need new recovery snapshots on subsequent moves. Existing snapshot retention limits still apply. Sessions whose content only changes in header cwd continue to reuse a snapshot.

## Local verification

The regression suite covers resident queueing and retry after unloading, a session loaded during flush, flush failure, snapshots including flushed data, repoint refusal without registry mutation, working-directory replay and byte-exact attach-failure rollback, plain/Zstd backup restore for legacy/v3/v4, and the exported plugin version. Full suite: 180 tests passed, 0 failed (Node v22.23.2). Syntax checks passed for lib/index.js and client/client.js. npm pack --dry-run --json passed (29 packaged files); no archive was published. git diff --check passed.

## Desktop acceptance checklist

Use disposable sessions and two test workspaces A and B. Test after loading this local source; the published npm version does not contain these changes.

1. Open a session in A, finish its current turn, then request migration to B. Expect a waiting task, no directory move, and a message about its resident writer. Merely becoming idle must not bypass the guard.
2. Close/unload that session, or restart DSH without reopening it. The durable migration task should finish. Reopen it in B and send a message. Confirm new events appear under B, with no new archive in A. Restart once more and confirm the session still loads.
3. On DSH 0.2.1-rc.2, change a disposable session's working directory before migration. Unload it, migrate A to B, then reopen it. The effective working directory should be B; original directory-change history should remain, followed by a change to B. Test the return move as well.
4. Create a recovery snapshot for a disposable v4 session, remove that test session through the rescue UI, then restore its backup. Expect `session.v4.jsonl[.zstd]`, successful reopening, and no generation mismatch in doctor.
5. Try workspace repoint while an affected session is resident. Expect refusal and the original registry path to remain. Unload the session and retry.

## Remaining validation

- Actual DSH Desktop and Web runtime: not run in this audit.
- Official runtime v4 session replay and continued writing: pending user acceptance.
- Node 22/24 matrix: local runtime only; CI has not run for these uncommitted changes.
- Host session loading concurrent with migration is not coordinated by a public host lifecycle lock. Plugin locks serialize plugin operations; residency is checked again before file replacement. Keep the test session closed while its queued move completes.
