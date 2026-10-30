# Changelog

## Unreleased

Danny works for you without being asked.

- **Goals.** Tell Danny you're looking into a new job, a move, a purchase, and he saves it with your criteria (`add_goal`, `list_goals`, `update_goal`). Goals show on the Tasks page with Pause, Done and Stop watching. Encrypted like everything else.
- **Watching.** A goal can be checked on the web every 6 to 168 hours. Danny only speaks up, in chat and by push, when a check finds something new (it is told what it reported last time). Max 5 watched goals; push stays quiet during quiet hours.
- **Web search.** `search_web` in chat, plus the searches above. Results are framed as untrusted text. Every search goes through the kill switch and daily cap and is billed per search (`PRICE_SEARCH_USD`, default 0.01) plus tokens.
- **Morning briefing.** Opt-in in Settings, at a time you pick in your timezone, once a day: calendar, top tasks, goal movement and up to three news items on what you care about.
- **Calendar.** `list_calendar` reads events; `create_event` makes an approval card and only adds the event (and invites any guests) after your tap. Optional Google permission (`calendar.events`): reconnect Google to add it. Existing logins keep working without it.
- Token savings from earlier in this branch: prompt caching, a stepped history window, clipped old tool results. The model and its price are shown in the status bar and Settings. Reminder notifications now lead with the task.
- **Evening wrap-up** (opt-in, Settings): what got done, what's open, tomorrow's top three. On Sundays it becomes a weekly review. No web search, so it costs a fraction of a cent. Says nothing on days with nothing to say.
- **Stalled goals:** two weeks with no progress and Danny asks, once, what's in the way. Fixed wording, no model call, so it's free. Never at night, never more than one goal per person per day. `goal_progress` (and any goal edit) resets the clock.
- **Interests and voice:** topics you follow shape the briefing's news (`add_interest` in chat or Settings, up to 15). Pick Foreman, Warm or Brief and Danny, briefings and wrap-ups all use it.
- **Danny learns how you like to be helped.** Two ways: you tell him in chat ("keep it shorter", "call me Jo") and he saves it with `learn_preference`; and once a week he looks at your recent messages and counts of what you did and notes lasting preferences (length, tone, timing). Everything is listed in Settings, "What Danny has learned", where you can forget one or all, or turn the weekly look off. Learned notes only reach the prompt as style and timing: anything about rules, approvals, sending, passwords or "ignore" is refused in code (`safeNote`), so a hostile email or web page can't teach him to skip an approval. Approvals themselves are still enforced in code, not by the prompt. He tells you in chat when the weekly look changed something. Needs at least 8 recent messages, costs a fraction of a cent a week.
- **Standing instructions and location** (Settings, "About you"): your own words, always in his prompt. Location plus a Celsius/Fahrenheit choice put a one-line weather forecast (Open-Meteo, no key; only the place name leaves the server) in the morning briefing.
- **Weather in chat.** `get_weather` answers "do I need a coat?" instantly for free, using your saved place and units (or any place you name). Today only; trips and longer forecasts still go through web search.
- **Quiet hours are a setting** (default still 22:00 to 07:00, any window, including ones that wrap midnight). Used by repeat reminders, goal watch alerts and stalled-goal check-ins.
- Migration `0014` adds `style_notes`, quiet-hour/units/learning columns on `users` and one scheduler function. Additive only.
- Migration `0013` adds `interests`, wrap-up and voice columns on `users`, goal progress columns, and two scheduler functions. Additive only.
- Migration `0012` adds `goals`, three briefing columns on `users`, and two read-only scheduler functions.

Tested against a real Postgres: 117 tests. Not tested: the live Anthropic web-search tool (`web_search_20250305`) and Google Calendar API, which need real keys. Check your first goal check and briefing by hand.

---

## Earlier in this branch

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
