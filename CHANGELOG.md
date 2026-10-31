# Changelog

## Unreleased

- **Call mode.** A Call button where Send is while the box is empty. Tap it and talk: Danny listens live, answers out loud in his own voice as he writes, and you can talk over him to stop him (or tap Interrupt). It is the same Danny as typed chat: same memory, tools and approvals, and the call is in the chat afterwards. Danny never approves anything by voice: he says it is waiting on your tap, and the card is in the app. Replies are written to be spoken (short, no lists or links). Details: audio goes phone to server over a WebSocket (`/v1/call`: login and origin checked, one call per account), the server relays it to ElevenLabs live transcription, and speaks each sentence with ElevenLabs text to speech as soon as it is written. His own voice coming back through the microphone is recognised and ignored, so he does not interrupt himself. Everything is billed to the same daily meter: listening by the second, speaking by the character, thinking by tokens as usual. The call ends at the daily allowance, at the stop switch, after `CALL_MAX_MINUTES` (default 10), or after two quiet minutes. Uses the ElevenLabs key already in the Owner tab; the voice is `ELEVENLABS_VOICE_ID`. New dependencies: `ws` and `@fastify/websocket`. No migration. **Not tested here:** the real ElevenLabs services (live transcription, speech) and a real iPhone from the Home Screen app, so the first real call is the test. Headphones help: a loud speaker can still echo. A call stops if the phone locks (a web app cannot keep the microphone then). Say in the privacy policy that voice goes to a third party.

- **API keys in the Owner tab.** One box per key Danny can use, each saying what it is for, marked Needed or Optional, with the steps to get it and a link. Paste a key, tap Save: Danny checks it with the provider first (free calls, fixed addresses), seals it like the Google credentials, and starts using it at once, with no restart. A key never comes back out of the API, is not written to the audit log (which records only which key changed), and one set in `.env` wins and shows as set on the server. Remove takes a second tap. Today: Anthropic (needed: without it Danny is in demo mode) and ElevenLabs (optional: voice typing). To add a key for a new feature, add one entry to `KEY_DEFS` in `lib/api-keys.ts`: after the next update the owner sees a new box. No migration. Not tested against the real providers: check your first key saves.

- **Voice typing.** A mic button next to Send: tap, speak, tap again, and your words appear in the box to read and fix. It never sends by itself. Recordings go to ElevenLabs' speech to text through the server (`POST /v1/transcribe`) and are not kept. Up to about two minutes each. It goes through the stop switch, the daily allowance and the spend ledger like everything else, billed by the second (`PRICE_STT_PER_HOUR_USD`, default 0.22: check ElevenLabs' current price). Needs `ELEVENLABS_API_KEY` in `.env`; without it the button stays hidden. No migration. Needs a real iPhone check from the Home Screen app, which the tests can't cover. Say in the privacy policy that voice goes to a third party.

Danny works for you without being asked.

- **Better recall.** Which notes Danny sees, and what `recall` returns, no longer needs the exact same word: *texts* finds *texting*, *moved* finds *Lives in Toronto*, *my brother* finds the note about a sister, *my instrument* finds the guitar. It also reads the last three things you said, so "what about her?" still finds the person you were just discussing, and a name in your message now beats a loose match. Among notes that match, newer, recently used and soon-due plans come first. Still plain code on the server: no model call, no cost, nothing sent out. No migration.
- **Remembers without being asked.** After each reply, one small model call looks at what you said and keeps durable things you mentioned in passing (people, routines, plans, preferences), or updates a note that changed. At most 3 per message; skipped for short messages and when Danny already saved something that turn. It runs after the reply is done, so it never delays an answer. Each save shows in the chat as "Noticed" with Undo, is marked "Danny noticed" in the Memory tab, and an updated note keeps its old wording for undo. It goes through the kill switch, daily allowance and ledger like everything else, and never keeps secrets or health, money, politics, religion or sexuality unless you ask. Turn it off in Settings, Remembering (`autoMemory`). Migration 0018.
- **Free daily allowance.** Everyone but the server owner gets US$1 a day (`DEFAULT_DAILY_CAP_USD`) and can no longer change it: `PATCH /v1/settings` with `dailyCapUsd` is owner-only (403 `owner_only`). Members see a usage meter (percent used, time until the midnight-UTC reset) instead of dollars; the owner still sees dollars and sets their own limit (`OWNER_DAILY_CAP_USD` is where it starts). The stop switch stays with everyone. Migration 0017 moves existing non-owner workspaces to $1.
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
- **Cards, quick replies and link previews in chat.** Danny's replies can now carry things you can use, drawn from a fixed menu the server validates and the app renders itself (never raw HTML):
  - **Task card** (after add_task / whats_next) with Done and Snooze 1h buttons right in the chat. It shows Done once the task is finished anywhere (Tasks tab, a notification).
  - **Calendar day**, **weather**, and **GitHub lists** as cards, instead of Danny typing them out. Tool results tell Danny not to repeat what the card shows.
  - **Quick replies**: `suggest_replies` puts 2 to 4 tap-to-send buttons under Danny's question ("Yes, watch it" / "Not now"). Only on the latest message, and they disappear once you answer.
  - **`show_card`** for a list of 3+ things (bullets, checklist or numbered steps, each item can link), a small table, or a place (with Apple Maps and Google Maps buttons).
  - **Link previews**: the first link in a message gets a small card with the site, title and description. The server fetches the page, so it is locked down: https only, no logins in the address or odd ports, bare IP addresses refused, every address a name resolves to must be on the public internet (checked at connection time, so a name can't answer differently to the check and the real request), redirects re-checked (max 4), 200 KB and 6 seconds at most, results cached for an hour, rate limited.
  - Cards are saved with the reply (encrypted, `messages.ui_enc`), so they are still there after a reload. Anything not on the menu is dropped, and links must be http(s).
- **Memory rework.** Used to be a flat pile: duplicates and contradictions piled up, the 50 newest notes went into every message whether relevant or not (note 51 silently vanished), nothing expired, and there was no way to edit.
  - **Saving is graceful.** The same thing said twice is kept once. Danny is shown similar notes when he saves and can replace an out-of-date one (`replaces`) instead of adding a second. Notes are short fragments, can carry a subject ("Marlene"), a kind (fact, preference, person, plan, place), a pin, and an expiry for time-bound things ("moving in March"). Things with their own home (tasks, goals, interests, learned style) are not also saved as memories. Capped at 300.
  - **Reading is selective.** Each message gets the pinned core plus the few notes that match what you just said (plain word overlap: free, private, no extra model call). With 10 notes or fewer, all of them go in. The rest is one `recall` away. Expired notes are skipped. Danny is told "Showing 6 of 40". New tools: `recall`, `forget_memory`.
  - **Weekly tidy** (own schedule, not tied to the learning toggle): archives long-expired notes, and with 15 or more notes, one cheap model call merges duplicates and shortens wordy ones. Nothing is deleted: merged notes are archived and shortened ones keep their old wording for 14 days, and the Memory tab shows "Danny tidied N notes. See and undo". Every model suggestion is checked in code (only your own notes, real ids, shortened by at least a fifth). Forgetting by hand still deletes for real.
  - **Memory tab:** grouped (pinned, how you like things, people, plans, places, everything else), searchable, with edit, pin, kind and expiry.
  - Migration `0016`: new columns on `memory`, `messages.ui_enc` (for cards, next), `users.last_tidied_at`, one scheduler function. Additive; existing notes carry over as plain facts.
- **Prettier messages.** The chat now draws a small, safe set of formatting: **bold**, dash lists as square bullets, `[name](link)` links, and long bare URLs shown as just the site name. Danny's prompts (chat, briefing, wrap-up, goal alerts, web search) share one set of layout rules (`lib/format.ts`): bold labels, one dash line per item, a blank line between sections, short link names, no headings, tables or emoji. Anything else the model slips in is tidied (a heading becomes a bold label, odd bullets become dashes). Built as data, never raw HTML, so a message can't inject anything; only http(s) links are clickable.
  - Fixed: goal alerts were cut off mid-word when the reply ran out of room. They get more room, and a reply that still runs out is trimmed back to its last complete line.
  - Fixed: goal alerts listed up to 8 raw links, mostly generic job-board pages. They now show only pages the answer actually cites (else the top results), at most 4, one per website, as links. The prompt tells Danny to link a specific listing, not a search-results page. Push notifications show the plain first line, with no symbols.
  - Older messages already in your history keep their old text, but bare links in them now display as short link names.
- **Connections screen (Settings, top).** One card per thing Danny can connect to, each with a state (Needs setup, Not connected, Connected, Reconnect) and a button that works. Replaces the old Gmail section, which dead-ended at "the server needs a Google client ID and secret".
  - **Google setup happens in the app.** The owner taps Set up Google and gets numbered steps with links, a copy button for the redirect address and the three permissions, and two boxes for the Client ID and secret. Danny asks Google whether they're right before saving (Google answers differently for a wrong secret versus a wrong code), then saves them encrypted and switches Google on with no restart. After that every person just taps Connect. People who aren't the owner see "the owner needs to finish setup" instead of a dead button. Values set in `.env` still win and are shown as read-only.
  - **Paste-a-token connectors.** A small registry (`lib/connectors.ts`): adding a connector is one entry with its fields, steps and a verify function, and the screen, encrypted storage, connect/disconnect and checks all come with it. First one: **GitHub** (`github_waiting`: reviews asked of you, issues assigned to you, your open PRs; also in the morning briefing). The token is checked against GitHub before it is saved, stored encrypted, and never returned.
  - Migration `0015` adds `server_secrets` (holds the owner-entered Google credentials).
- **Update and backup from the Owner tab, no SSH.** A Server card shows the version, how many updates are waiting (and what they are), recent backups and the result of the last action, with Check for updates, Back up now and Update Danny (with a confirm). It keeps polling through the restart. Safe by design: the app has no Docker socket and runs nothing. It drops an empty file named `check`, `backup` or `update` in a folder; a root script on the server (`deploy/ops.sh`, started instantly by a systemd path unit) looks only at those three exact names, ignores everything else (other names, folders, links, file contents), takes a lock so the watchdog doesn't repair things mid-update, runs the existing `backup.sh` / `update.sh` (so you keep the verified backup and automatic rollback), and writes results to a folder the app can only read. **One-time step on the server after your next `danny update`: `danny ops-install`.** New servers get it from `bootstrap.sh`; later `danny update` runs refresh it.
- Fixed: briefings and wrap-ups no longer show raw `**asterisks**` (the app shows text as written; markdown is now forbidden in prompts and stripped as a backstop). A briefing or wrap-up turned on more than 4 hours after its set time is skipped for that day instead of arriving as a late "good morning".
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
