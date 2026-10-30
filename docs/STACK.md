# Danny backend stack

Chosen for three things: fast to ship, safe with other people's data, and cheap to run on one VPS.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), end to end | One language for server, web app, Capacitor and Tauri shells, with shared types. The server spends its time waiting on the Anthropic API, so raw language speed is not the bottleneck. |
| Runtime | Node 22 LTS | Proven in production. Bun can be revisited later. |
| HTTP | Fastify 5 | Fast, mature, good plugin set (helmet, cookies, rate limits). |
| Database | PostgreSQL 16 | Real multi-tenancy needs concurrent writers, background jobs and row-level security. SQLite is faster on one box but cannot give database-enforced tenant isolation. |
| Queries | Drizzle ORM + generated SQL migrations | Typed queries, plain SQL migrations that can be reviewed. |
| Validation | Zod | Every request body, query and param is parsed. |
| Passwords | argon2id (`@node-rs/argon2`) | OWASP-minimum parameters. |
| Sessions | Opaque random token in an HttpOnly cookie, SHA-256 hashed in the database | Revocable, and a database leak does not leak usable sessions. |
| Web app | Svelte 5 + Vite + TypeScript, one responsive interface | The same build is the phone PWA and the desktop app: sidebar on wide screens, bottom tabs on phones. 72 KB of JavaScript. Served by the API on the same origin, so cookies and the origin check stay simple. |
| Jobs (next) | pg-boss | Queue inside Postgres, so no Redis to run. |
| Model API (next) | `@anthropic-ai/sdk`, streaming, SSE to the browser | |

## How multi-tenancy works

- A **workspace** is the tenant. Every user gets a personal workspace. Teams can share one later without a schema change.
- Every tenant table carries `workspace_id`.
- The API connects as `danny_app`, a restricted role. Migrations run as a different owner role.
- Every tenant query runs inside `withTenant(workspaceId, ...)`, which sets `app.workspace_id` for that transaction. Row-level security policies then make other workspaces' rows invisible and unwritable, even if a query forgets its `WHERE`.
- `audit_log` and `spend_ledger` are append-only for the app role.
- The owner's usage view reads through one `SECURITY DEFINER` function that returns only money and counts.

## Encryption

- **At rest, in the application.** Memory, chat messages, approval drafts and connection secrets are encrypted with AES-256-GCM before they reach the database. A stolen dump or backup shows only bytes.
- **One key per workspace**, derived from a master key in `DATA_KEYS`. The database never holds the master key.
- **Bound to the workspace.** A value copied into another workspace's row fails to decrypt, so it does not leak there.
- **Rotation.** Add a new key version to `DATA_KEYS`; new writes use it and old data still opens. Keep old keys until everything has been re-sealed.
- **Connection secrets** (linked accounts, API keys) are write-only through the API: nothing returns them. Only server-side tool code can read one.
- **Not encrypted:** account emails, approval titles, timestamps and the audit log's action names. These stay readable so the app can list and search them. Passwords are hashed (argon2id), not encrypted.
- **Limits.** The server holds the key while it runs, so this protects data at rest and in backups, not against someone with live access to the running server. Everything also travels over HTTPS.
- **Lost key = lost data.** Back up `DATA_KEYS` separately from the database.

## What is deliberately not here yet

- Chat and the model tool loop (next slice).
- Email sending. The owner receives the invite link and passes it on.
- Billing, push notifications, connectors. Approvals are recorded, never executed, and the API says so in every response.

## Deviations from the written build direction

- **Postgres instead of SQLite**, for the reasons above. It still deploys with one Docker Compose file.
- **Dependencies instead of zero.** Auth, validation and HTTP hardening are not worth hand-rolling for a multi-user service.
