# Changelog

## Unreleased

Self-healing deployment.

- `deploy/bootstrap.sh`: one command turns a fresh Ubuntu/Debian server into a running Danny. Checks the server and DNS first and stops with a plain sentence if something is wrong. Installs Docker, adds swap on small servers, sets the firewall, turns on automatic security updates, runs `setup.sh`, installs the watchdog and nightly backup, and runs the doctor. Safe to re-run.
- Watchdog (every minute): after 3 bad checks it repairs in steps (bring the stack up, restart the API, restart the database), then stops instead of looping and says so.
- `/readyz`: ready means the database answers **and** the reminder scheduler is still ticking. A scheduler that silently stops would otherwise mean reminders just never arrive. Docker's health status uses it; Caddy does not expose it to the internet.
- `danny doctor | backup | restore | update | logs`. Backups are verified, private and kept 14 days. `danny update` backs up, builds, migrates and starts, and puts the old code back if the new version won't come up.
- Container logs rotate, so they can't fill the disk.
- Fixed: `./setup.sh` with no domain wrote production mode with insecure cookies, which the API refuses to start with, so that path never worked. It now runs in development mode on 127.0.0.1 only.
- Found by actually building the image for the first time: the Dockerfile builds and the stack comes up healthy. (In the sandbox the build needed the egress proxy's CA; a normal server does not.)

Tested: 37 script scenarios against fake docker/git, 21 checks against real containers (setup, readiness, login, backup, restore, watchdog repairing a stopped API and database). Not tested: `bootstrap.sh`'s own apt/Docker-install/ufw/swap/systemd steps, which need a real fresh server.

---

## Earlier (Gmail connector)

Gmail connector, and approvals that actually run.

- Connect Gmail from Settings (Sign in with Google). Danny can search and read mail, and draft emails or replies as cards. A card shows the exact recipients, subject and text. **Send it** sends from your Gmail, threaded under the original for replies. See `docs/GMAIL_SETUP.md`.
- Least privilege: read and send only. Danny cannot delete, archive or edit mail. No bcc.
- Approvals now execute for tools that define an executor. The card says what happened: Sent, Didn't send (with Try again), or Check Gmail when it can't be sure. A second tap or a double-click never sends twice.
- Email text is framed to the model as untrusted data. Nothing is sent from chat without a tap.
- Disconnecting revokes the login at Google. Connecting again replaces and revokes the old one. If Google stops honouring the login, Danny says so and Settings offers Reconnect.
- Closed a gap: `POST /v1/approvals` can no longer create a card of an executable kind, and stored payloads are re-validated before they run.

Not yet verified: a real Google consent screen and a real send (tests use a fake Google; a real-browser run covered the callback, cookies and UI). Needs a Google OAuth client from you.

---

## Earlier (reminders branch)

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
