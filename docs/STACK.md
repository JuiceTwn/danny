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
| Jobs | A timer inside the API process (`brain/heartbeat.ts`), with an atomic per-workspace claim in Postgres | One server, so no queue to run. A run is claimed with one `UPDATE`, so two processes can't both start it. Move to pg-boss if jobs ever need retries or fan-out. |
| Model API | `@anthropic-ai/sdk`, streaming, SSE to the browser | Two models: `MODEL` for chat, `PLANNER_MODEL` for self-review. |

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

## How Danny works on his own

- A **goal** has steps, notes, and a `next_review_at`. Danny sets that himself when he reviews it.
- Each tick, a free query asks "is any review due, or was a card decided since the last run?" Only a yes calls the planner model.
- A review gets the goals, memory, recent chat and what is waiting on the boss. It may use every tool chat can. It can plan and draft. It cannot send.
- Limits, enforced in code: the kill switch and daily cap (shared with chat), runs per day, a 10 minute gap, 8 cards waiting at most, 12 goals, 15 steps per goal.
- A goal that was due and not rescheduled moves out a day after every run, so one stuck goal can't wake him every tick.
- `external_write` tools (like `send_email`) run only from `executeApproved`, after the user taps Approve, once per card.

## What is deliberately not here yet

- Connectors other than email (Google Business Profile, calendar, social). Approvals for those are recorded, not executed.
- Billing and push notifications.
- Prompt caching. The spend count ignores cache discounts, so the cap over-counts rather than under-counts.

## Deviations from the written build direction

- **Postgres instead of SQLite**, for the reasons above. It still deploys with one Docker Compose file.
- **Dependencies instead of zero.** Auth, validation and HTTP hardening are not worth hand-rolling for a multi-user service.
