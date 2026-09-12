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

Only cross-group drops are intercepted; official same-group reorder stays untouched. After a successful move the client relies on the official workspace-change event (page reload is the user-facing fallback).

## RPC channel

Single logical channel `/workspace-mover` via `ctx.connection.rpc.handle('/workspace-mover', …)`. No independent REST routes.

| Endpoint | Purpose |
| --- | --- |
| `mover.status` | Capability report (detected services / degraded items) |
| `mover.workspaces` | List workspaces |
| `mover.move` | Single-session true move |
| `mover.moveMany` | Bulk move (≤50 / batch) |
| `mover.scan` | Classified rescue scan |
| `mover.repair` | Attach / relink one item |
| `mover.repairAll` | Batch repair (per-item isolation) |
| `mover.history` | Recent moves (≤100) |
| `mover.undo` | Undo one history entry |
| `mover.ws.audit` | Workspace path health |
| `mover.repoint` | Move-home wizard |
| `mover.archived` / `mover.unarchive` | List / restore archived sessions |
| `mover.openFolder` | Open group directory in OS file manager |
| `mover.session.delete` | Session → recycle bin |
| `mover.trash.list` / `mover.trash.restore` / `mover.trash.purge` | Recycle bin |
| `mover.backups.list` / `mover.backups.restore` / `mover.backups.deleteOne` | Backup management |

Errors carry stable codes (`busy`, `conflict`, `not-found`, `rollback-failed`, …). Host logs write failures under `MOVE FAILED`.

## Session archives (v3)

- Naming: `session.v3.jsonl.zstd` or `session.v3.jsonl` (highest generation wins).
- Mixed compression in one persistence root is rejected explicitly.
- True move keeps the session id and all frames; only the header `cwd` (first frame) is rewritten; other frames stay byte-identical. Publish via temp file + atomic rename.

## Move pipeline

Order of operations for a cross-workspace move:

1. **Running check** — reject only mid-turn sessions (`agents.get(id)?.status === 'running'`); idle resident sessions may move.
2. **Read authority header** from disk; verify target ≠ source.
3. **Preflight** — dual-accounting detect, target writability probe, disk-space hint.
4. **Byte backup** to `$DSH_HOME/workspace-mover/backups/` (rolling 20 per session) **before any side effect**.
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

Verified:

- DeepSeek Harness `0.1.5-rc.1`
- dsh-market `1.45.1`
- Node.js `≥ 22`
- `package.json` → `engines.dsh`: `>= 0.1.5-rc.1`

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

## Tests & release

- `npm test` runs `test/core.test.mjs`, `test/e2e-sandbox.test.mjs`, `test/traffic-badge.test.mjs`, `test/release-downloads.test.mjs` (95 cases at v2.0.1).
- Coverage includes rollback, rescue scan/repair, history undo, workspace repoint, post-move verification, recycle bin / backup restore, task center, data-protection cleanup, concurrency locks, error codes.
- CI: `.github/workflows/test.yml`.
- Release assets may ship a `.tgz` install package (`dsh-workspace-mover-*.tgz`).
- Traffic/clones and release-download badges are refreshed by `.github/workflows/traffic-badge.yml` via Gist JSON endpoints (not part of the runtime plugin).

## Related docs

- User install/usage: [README.md](../README.md), [README_EN.md](../README_EN.md)
- Full version history: [CHANGELOG.md](../CHANGELOG.md)
- Security policy: [SECURITY.md](../SECURITY.md)
