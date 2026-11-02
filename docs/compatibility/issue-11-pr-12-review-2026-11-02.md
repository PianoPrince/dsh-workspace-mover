# Issue #11 / PR #12 candidate review

Release: `2.4.3`, based on accepted candidate `2.4.3-rc.2`.

## Contribution review

PR #12 pinned head: `6101e720c69e3d512d84a9ab1c581e6c920afd10`, author EzraRT.
Reviewed all changes: `client/client.js`, `package.json`, `CHANGELOG.md`.
No new network requests, process execution, credential access, filesystem deletion,
installation scripts, workflow changes or runtime dependency downloads were found.

Local integration retains the contribution, adds locale notification/subscription
cleanup and regression coverage, and removes the new mandatory manifest injection
so hosts without the optional locale service can still load the plugin.
Language changes update the React repair panel and subsequent dialogs. An open
confirmation dialog retains its text until reopened; it never restarts a migration.

PR #6 remains excluded: private writer rebinding is superseded by the shipped
public lifecycle release/resume strategy.

## Issue #11 scope

Tracked idle sessions: release the public handle, move the archive to recycle,
preserve title/projection/ownership metadata, and do not reload on success.
Running sessions are refused without cancelling their task. Untracked resident
sessions retain the full-restart requirement. Failure reloads only if an archive
can be located; failed rollback keeps recovery files intact.

Ghost membership is diagnostic only: archives elsewhere in the active storage
root are distinguished from unknown locations, including unparsed files beyond
the scan limit. Other storage roots or external archives cannot be inferred.
Automatic or bulk roster deletion and an external detach API are deferred;
ownership and archived membership remain intact.

## Desktop acceptance (dedicated disposable conversation)

1. Fully quit DSH from its tray menu and restart from the updated desktop shortcut.
   Repair-panel self-check must report `2.4.3-rc.2` (Desktop `0.2.1-rc.5`).
2. Create a test conversation, send one message and wait for completion. Delete it
   from the plugin's repair panel. Expect no restart requirement, no duplicate
   conversation, and no stuck removed view if it was selected.
3. Restore it from the plugin recycle bin. Title, history and workspace must remain
   intact. If it was archived before deletion, the restore note explicitly says
   it remains archived: use Restore under Archived sessions to return it to the
   ordinary sidebar. Both lists must update without restarting; sending another
   message must work.
4. While a test conversation is generating, attempt deletion. It must be refused,
   and the original task must continue. Delete only after it becomes idle.
5. Switch DSH between English and Chinese. The repair panel and a newly opened
   migration confirmation must follow DSH rather than the browser language.
   Cancel the confirmation; no physical migration is needed for this check.
6. Move a disposable idle conversation across workspaces and send another message
   to confirm the existing migration/reconnection behavior is preserved.

No manual movement or deletion of real session files is required. Automated
fixtures cover unknown/moved ghost records and failed physical rollback.

## Automated validation

- rc.2 `npm run check`: 337 tests, 334 passed, 3 installed-runtime tests skipped;
  syntax and npm package dry-run passed.
- `npm run test:installed-host` against dependencies extracted from the installed
  Desktop `0.2.1-rc.5`: 6 passed, none skipped. Includes real AgentLoop disposal,
  physical migration, subsequent write, resident deletion and official locale.
- Final syntax check and candidate `npm pack` passed. Candidate hashes and command
  logs are retained locally under `data/pr-review-20261102/` (not packaged).
- PR #12 GitHub workflow run `41188742982` required maintainer approval, granted
  during release preparation. Cross-platform CI is required before merging.
- Desktop configuration already links to this checkout. A full quit/restart is
  required to load the new host version; do not edit the Desktop application ASAR.
- The rc.2 installed-client check removes a Session from the real Controller's
  list, refreshes its cold baseline through `ClientSessions.refresh()`, and checks
  that it reappears without a restart or Agent-created event. DOM tests cover
  refresh after all three restore/unarchive endpoints and failure without retrying
  completed restoration.

## Desktop feedback on rc.1 — 2026-11-03

The user confirmed self-check `2.4.3-rc.1`, deletion of an idle archived test
conversation without restarting, successful English repair-panel/dialog text and
cross-workspace migration. Recycle restoration did not immediately populate the
sidebar; restarting restored visibility. This exposed a missing client Session
baseline refresh, since file restoration emits no Session-created event. rc.2
refreshes the public `sessions.refresh()` after restore/unarchive and explicitly
reports preserved archived status.

The screenshot of a running task showed the host's "Stop and archive" dialog;
the user approved it and archiving succeeded. This verifies host behavior, not
the plugin's running-session deletion refusal. The latter remains covered by
automated checks; no manual pass is claimed.

## Desktop acceptance of rc.2 — 2026-11-03

After the prescribed restore regression steps, the user reported “测试通过” and
authorized the complete release flow. This accepts deletion, recycle recovery,
immediate archived-list visibility, unarchiving back to the sidebar and continued
replies without restarting between those actions. rc.1 English repair-panel and
migration-dialog screenshots and successful migration remain the language/move
acceptance evidence. The host's Stop and archive dialog is not substituted for
manual testing of the plugin's running-deletion refusal.

Formal version promotion changes metadata/documentation only; runtime sources
match the accepted rc.2. No session data or personal screenshots are packaged.
