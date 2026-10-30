# @danny/api

Multi-tenant API. See `../../docs/STACK.md` for the decisions.

```bash
# 1. A Postgres 16 server, a database, and two roles:
#    danny_owner (owns the tables, runs migrations) and danny_app (runtime, restricted)
# 2. Environment: copy .env.example and fill it in
npm run db:migrate
npm run create-owner -- you@example.com 'a long password' 'Your Name'
npm run dev
```

Tests need a throwaway Postgres: `bash scripts/test-db.sh`, then `npm test`.

Routes (all JSON, session cookie, same-origin check on writes):

| | |
|---|---|
| `POST /v1/invite-requests` | public, from the marketing site |
| `POST /v1/auth/accept-invite`, `login`, `logout` · `GET /v1/me` | |
| `GET/POST /v1/memory`, `DELETE /v1/memory/:id` | |
| `GET/POST /v1/approvals`, `POST /v1/approvals/:id/decision` | recorded, never executed |
| `POST /v1/chat` (streams events), `GET /v1/chat/history`, `GET /v1/tools` | the model loop; see `src/tools/registry.ts` for how to add a tool |
| `GET/POST /v1/goals`, `PATCH /v1/goals/:id`, `POST /v1/goals/:id/steps`, `PATCH /v1/goals/:id/steps/:stepId` | goals and plans |
| `POST /v1/agent/run` | "review now": one self-review, under the same cap and daily run limit |
| `GET/PATCH /v1/settings` | daily spend cap, kill switch, self-review on/off and runs per day |
| `GET /v1/admin/invite-requests`, `POST .../:id/approve`, `POST /v1/admin/invites`, `GET /v1/admin/usage` | owner only |

## Working on his own

`src/brain/heartbeat.ts` runs every `AGENT_TICK_SECONDS` and calls `wakeReason` (a plain query, no model) for each workspace that has self-review on.
Only if a goal review is due, or a card was decided since the last run, does `runAgent` (`src/brain/agent.ts`) call the planner model.
A run can use every tool chat can, so it can plan and draft but never send. `external_write` tools only run in `executeApproved` (`src/brain/execute.ts`), after the user's tap.

## Adding a tool

Write one file with `defineTool({ name, description, kind, input, run })` and register it in `src/tools/builtin.ts`.
`kind: "external_write"` tools never run from chat or from a review: the loop turns the call into an approval card.
Give one an `execute` function and it runs once, after the user taps Approve (see `src/tools/email.ts`). Without one, approval is only recorded.

## Deploying

From the repo root on a server with Docker: `./setup.sh app.example.com`, or `./setup.sh` for plain HTTP.

## The web app

`apps/web` is the interface (Svelte + Vite). Build it with `npm run build -w @danny/web`; the API serves it from `WEB_DIR`.
For development run the API on :8787 and `npm run dev -w @danny/web` on :5173 (it proxies `/v1` to the API).
