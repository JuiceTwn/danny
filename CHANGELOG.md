# Changelog

## Unreleased

Danny works on his own.

- Goals and plans: each goal has steps, notes and a next-review time. Encrypted like memory, isolated by row-level security. Limits: 12 active goals, 15 steps each.
- Goals tab in the app. Danny also starts and updates goals from chat, and sees them every turn.
- Self-review: when a goal's review comes due, or the boss decides a card, Danny wakes up, replans, drafts, and tells the boss in chat what he did (or stays quiet). Runs on `PLANNER_MODEL` (default Sonnet 5.5); chat stays on `MODEL` (default Haiku 5.5).
- The wake-up check is free: no model call unless something is actually due. A scheduler pass runs every `AGENT_TICK_SECONDS` (default 300) when a model key is set. "Review now" in the app forces one.
- The leash: off until an admin turns it on; the same kill switch and daily spend cap as chat; at most N reviews a day (default 6); at least 10 minutes between runs; at most 8 cards waiting on the boss; a review can draft but never send.
- Email that really sends: `send_email` drafts a card, and only the boss's tap on Approve sends it, through a linked Resend account (Settings). 20 a day. If no account is linked or the service refuses, the card says nothing was sent. Other approval kinds are still recorded only.
- Model prices are now a built-in table by model (Haiku 5.5, Sonnet 5.5, Opus 5.5, ...), replacing the placeholder `PRICE_*` variables. `MODEL_PRICES` overrides. Unknown models are priced at the highest known rate so the cap errs safe.
- Chat requests set a low effort and a larger output limit, so thinking doesn't eat the reply.

Not done:

- Connectors for Google Business Profile, calendar and social posting. Only email can leave the app.
- Prompt caching, so cache reads aren't discounted in the spend count yet (the cap over-counts, never under-counts).
- Real model calls are still untested: all of this runs against a scripted model, as 1.0 did.
- No push notifications; the app picks up Danny's messages while it's open.

## 1.0.0

First complete version of Danny: a multi-tenant API and a responsive web app (PWA and desktop-install from one build).

- Invite-only accounts, one workspace per user, sessions in revocable cookies
- Chat with streaming replies, a tool registry, and an approval gate: anything that would leave the app becomes a card for the user's tap
- Memory the user can see and delete
- Approvals are recorded, never executed
- Daily spend cap and a kill switch, enforced before every model call
- Tenant isolation enforced by Postgres row-level security
- Memory, messages, approval drafts and titles, and connection secrets encrypted at rest with per-workspace keys and key rotation
- Owner tools: approve invite requests, make invite links, see spend per person
- Docker Compose, one-command setup script, CI

Known gaps at 1.0:

- Real Anthropic API calls have not been run; tests use a scripted model. Without a key the server runs in demo mode.
- The Docker image and `setup.sh` have not been built or run end to end.
- Install flow and offline mode have not been tried on real phones.
- Model prices in config are placeholders.
- Nothing is sent outside the app yet (no email, calendar, or social connectors).
- Invite emails are not sent; the owner copies the link.
