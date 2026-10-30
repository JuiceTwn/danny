# Hosting Danny

Danny runs on one small server (a VPS) with Docker. This is the whole path from an empty server to a running, self-looking-after Danny.

## What you need
- A VPS running **Ubuntu 22.04/24.04 or Debian 12**, with root access. About 1 vCPU and 2 GB RAM is enough. (Use the host's VPS product, not shared or "web" hosting.)
- A domain, with an **A record** for `app.yourdomain.com` pointing at the server's IP. Wait for it to resolve.
- The repo on the server. It is private, so use a read-only deploy key or a fine-grained token with read access to this repo only.

## Install (one command)

```
git clone <your repo url> danny && cd danny
sudo ./deploy/bootstrap.sh app.yourdomain.com
```

It checks the server first and stops with a plain sentence if something is wrong (not root, wrong OS, not enough disk, something already on port 80/443, the domain not pointing at this server). Then it:

1. installs Docker from Docker's own apt repository,
2. adds 2 GB of swap if the server has under 2 GB of RAM (builds can run out of memory otherwise),
3. opens only SSH, 80 and 443 in the firewall (SSH is allowed before the firewall is switched on, so it cannot lock you out),
4. turns on automatic security updates,
5. runs `setup.sh`: generates secrets and push keys, builds Danny, starts him with HTTPS, runs the database migrations,
6. installs the watchdog and nightly backup timers and the `danny` command,
7. takes a first backup and runs the doctor.

Run it again any time. Every step checks before it acts. Without a domain it still works, but Danny is only reachable from the server itself (use an SSH tunnel).

Then finish by hand (it prints these):
- create your account: `docker compose exec api node dist/cli/create-owner.js you@example.com 'a long password' 'Your Name'`
- put `ANTHROPIC_API_KEY` (and the Google keys, see `GMAIL_SETUP.md`) in `.env`, then `docker compose up -d`
- **copy `DATA_KEYS` from `.env` into a password manager.** Without it nothing can be read, not even from a backup. Never store it next to the backups.

## What looks after itself

| Problem | What happens, with no one watching |
|---|---|
| Danny's process crashes | Docker restarts it. |
| The server reboots | Docker starts on boot and brings Danny back. |
| Danny hangs, or the database stops answering | The watchdog (every minute) waits for 3 bad checks, then repairs in steps: bring the stack up, restart the API, restart the database and API. After 3 repairs it **stops** (no restart loops), logs loudly, and `danny doctor` tells you. |
| The reminder scheduler silently stops | `/readyz` goes unhealthy (it checks the scheduler is still ticking, not just that the process is up), so the watchdog restarts the API. Without this, reminders would just stop with nothing visibly broken. |
| Logs fill the disk | They rotate (3 files of 10 MB per container). |
| The disk is nearly full | The watchdog clears unused Docker images and build cache. |
| Security patches | Installed automatically. The server does not reboot itself, so reboot now and then. |
| HTTPS certificate expiry | Caddy renews it on its own. `danny doctor` warns if one is close to expiring. |
| Data loss | A verified backup every night, 14 days kept in `/var/backups/danny`. |

## What it does NOT do
- It never edits code, config or data to "fix" things. Repairs are only restarts and cleanup of unused images.
- It cannot tell you the whole server is down, because it dies with the server. Add a free outside monitor (UptimeRobot, Better Stack) on `https://app.yourdomain.com/healthz`.
- Backups live on the same server. A server that is lost or wiped takes them with it. Copy them off now and then (`scp`, or a cron job to storage you control).
- It doesn't undo database migrations. Updates only add to the schema, so rolling the code back is safe, but to go back further use a backup.

## Looking after it

```
danny doctor            check everything and say what is wrong in plain words
danny doctor --fix      also do the safe repairs
danny backup            back up now
danny restore <file>    replace the database with a backup (takes a safety backup first)
danny update            pull the latest code, back up, build, migrate, start; rolls back if it won't start
danny logs [service]    follow the logs
```

`danny update` only fast-forwards. If the checkout has local changes or has diverged from `origin`, it stops without touching anything.

## Restoring
`danny restore /var/backups/danny/danny-<date>.sql.gz` stops Danny, replaces the database, starts him, and waits for him to be healthy. You need the same `DATA_KEYS` that were in use when the backup was taken.

## How this was tested
- `bash deploy/test/scripts.test.sh` runs the real scripts against a fake `docker` and `curl`: the watchdog's escalation, cooldown and giving up, backup verification and retention, restore ordering, the doctor, and `update.sh` with real git (success, build failure, unhealthy start, dirty tree, diverged history, detached HEAD).
- `bash deploy/test/integration.sh` uses real containers: first-run setup, readiness, login, backup, restore (and that login still works afterwards), and the watchdog bringing back a stopped API and a stopped database. It needs a Docker daemon.
- `shellcheck` is clean on every script.
- **Not tested on a real server:** `bootstrap.sh`'s own system steps (apt, installing Docker, ufw, swap, systemd timers) can only be run for real on a fresh Ubuntu/Debian machine. Treat the first run as the test, on a server you can afford to wipe.
