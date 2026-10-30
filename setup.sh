#!/usr/bin/env bash
# One-command setup on a fresh VPS with Docker installed.
#   ./setup.sh                 plain HTTP on 127.0.0.1:8787, for trying it out (not reachable from outside the machine)
#   ./setup.sh app.example.com automatic HTTPS with Caddy (point the domain's DNS at this server first)
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${1:-}"
rand() { head -c 24 /dev/urandom | base64 | tr -d '=+/' | head -c 32; }

if [ ! -f .env ]; then
  {
    echo "POSTGRES_PASSWORD=$(rand)"
    echo "DANNY_OWNER_PASSWORD=$(rand)"
    echo "DANNY_APP_PASSWORD=$(rand)"
    echo "# Encrypts everything users write to Danny. BACK THIS UP: without it, stored data cannot be read."
    echo "DATA_KEYS=1:$(head -c 32 /dev/urandom | base64)"
    echo "ANTHROPIC_API_KEY="
    echo "# Gmail: see docs/GMAIL_SETUP.md. Leave blank to run without it."
    echo "GOOGLE_CLIENT_ID="
    echo "GOOGLE_CLIENT_SECRET="
    echo "MODEL=claude-haiku-5-5"
    if [ -n "$DOMAIN" ]; then
      echo "NODE_ENV=production"
      echo "APP_URL=https://$DOMAIN"
      echo "APP_ORIGINS=https://$DOMAIN"
      echo "COOKIE_SECURE=true"
    else
      # Plain HTTP can't carry secure cookies, and production mode refuses to run without them. So this is development mode:
      # fine here because compose only publishes the API on 127.0.0.1 (reach it from another machine with an SSH tunnel).
      echo "NODE_ENV=development"
      echo "APP_URL=http://localhost:8787"
      echo "APP_ORIGINS=http://localhost:8787"
      echo "COOKIE_SECURE=false"
    fi
    echo "# Origins of your marketing site, so its invite form can post here"
    echo "MARKETING_ORIGINS="
  } > .env
  chmod 600 .env
  echo "Wrote .env. Back up DATA_KEYS somewhere safe and separate: if it is lost, encrypted data cannot be recovered."
  echo "Add ANTHROPIC_API_KEY to it when you have one (without it, Danny runs in demo mode)."
fi

if [ -n "$DOMAIN" ]; then
  # /readyz is for the watchdog and Docker on this machine only, so it is not served to the internet.
  printf '%s {\n\t@internal path /readyz\n\thandle @internal {\n\t\trespond 404\n\t}\n\thandle {\n\t\treverse_proxy api:8787\n\t}\n}\n' "$DOMAIN" > deploy/Caddyfile
  PROFILE=(--profile https)
else
  PROFILE=()
fi

# Reminders reach the phone through web push, which needs a key pair. Made once, kept in .env.
if ! grep -q '^VAPID_PRIVATE_KEY=.' .env; then
  [ -n "${DANNY_NO_BUILD:-}" ] || docker compose build api
  docker compose run --rm --no-deps -T api node dist/cli/vapid.js >> .env
  if [ -n "$DOMAIN" ]; then echo "VAPID_SUBJECT=https://$DOMAIN" >> .env; else echo "VAPID_SUBJECT=mailto:you@example.com" >> .env; fi
  echo "Added VAPID keys to .env (needed for push reminders). Set VAPID_SUBJECT to your real contact email or site if you change it."
fi

# DANNY_NO_BUILD=1 reuses an image that is already built (used by the integration test).
BUILD=(--build)
[ -z "${DANNY_NO_BUILD:-}" ] || BUILD=()
docker compose "${PROFILE[@]}" up -d "${BUILD[@]}"
docker compose exec -T api node dist/cli/migrate.js
echo
echo "Up. Create the first (owner) account:"
echo "  docker compose exec api node dist/cli/create-owner.js you@example.com 'a long password' 'Your Name'"
