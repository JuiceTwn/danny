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
| Jobs (next) | pg-boss | Queue inside Postgres, so no Redis to run. |
| Model API (next) | `@anthropic-ai/sdk`, streaming, SSE to the browser | |

## How multi-tenancy works

- A **workspace** is the tenant. Every user gets a personal workspace. Teams can share one later without a schema change.
- Every tenant table carries `workspace_id`.
- The API connects as `danny_app`, a restricted role. Migrations run as a different owner role.
- Every tenant query runs inside `withTenant(workspaceId, ...)`, which sets `app.workspace_id` for that transaction. Row-level security policies then make other workspaces' rows invisible and unwritable, even if a query forgets its `WHERE`.
- `audit_log` and `spend_ledger` are append-only for the app role.
- The owner's usage view reads through one `SECURITY DEFINER` function that returns only money and counts.

## What is deliberately not here yet

- Chat and the model tool loop (next slice).
- Email sending. The owner receives the invite link and passes it on.
- Billing, push notifications, connectors. Approvals are recorded, never executed, and the API says so in every response.

## Deviations from the written build direction

- **Postgres instead of SQLite**, for the reasons above. It still deploys with one Docker Compose file.
- **Dependencies instead of zero.** Auth, validation and HTTP hardening are not worth hand-rolling for a multi-user service.
