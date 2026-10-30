# Changelog

## Unreleased

Tasks and reminders, built for people who lose track of things.

- Tasks: Danny adds them from chat (`add_task`), lists them, marks them done, snoozes them, and answers "what's next" with one task. A Tasks tab in the app does the same.
- Reminders that come back: first nudge at the time asked, then 10 min, 30 min and 2 h later if ignored, then stop. Repeat nudges wait out quiet hours (10pm to 7am).
- Web push notifications (Done and Snooze buttons on the notification), plus every reminder is written into the chat. Needs VAPID keys; `setup.sh` makes them.
- Timezone follows the device, so reminders and quiet hours use the user's clock.
- Fixed: the owner's usage view showed $0 for everyone when the database owner was not a superuser (as in the Docker setup), because row-level security also applies to the table owner. The same issue would have stopped reminders from ever firing. Tests now migrate as a non-superuser owner so this is caught.

Not yet verified: web push to a real phone, the Docker image and `setup.sh` (no Docker daemon was available), iOS install flow.

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
