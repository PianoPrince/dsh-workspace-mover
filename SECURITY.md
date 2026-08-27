# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.4.x | ✅ |
| < 0.4.0 | ❌ |

## Reporting a Vulnerability

Please do not report security vulnerabilities in a public issue.

Use GitHub Security Advisories when enabled for the repository. If unavailable, contact the repository maintainers privately with a description, affected versions, reproduction steps, and possible impact.

Do not attach real session archives or private workspace data. Redact paths, tokens, prompts, and conversation content.

## What the Plugin Touches

- Reads and writes session archives and workspace registry state under `$DSH_HOME` only; it performs no network access and has zero npm dependencies on the host side.
- Backups are written to `$DSH_HOME/workspace-mover/backups/` (rolling 20 per session) and move history to `$DSH_HOME/workspace-mover/history.json`.
- The client half runs inside your DSH web session and uses official design tokens; it only reads ARIA attributes of sidebar rows.

Reports involving data loss, unsafe file movement, path traversal, unauthorized RPC access, or disclosure of session content are especially important.
