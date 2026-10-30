#!/usr/bin/env bash
# One-command setup on a fresh VPS with Docker installed.
#   ./setup.sh                 plain HTTP on port 8787 (behind your own proxy, or for trying it out)
#   ./setup.sh app.example.com automatic HTTPS with Caddy (point the domain's DNS at this server first)
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${1:-}"
rand() { head -c 24 /dev/urandom | base64 | tr -d '=+/' | head -c 32; }

if [ ! -f .env ]; then
  {
    echo "NODE_ENV=production"
    echo "POSTGRES_PASSWORD=$(rand)"
    echo "DANNY_OWNER_PASSWORD=$(rand)"
    echo "DANNY_APP_PASSWORD=$(rand)"
    echo "# Encrypts everything users write to Danny. BACK THIS UP: without it, stored data cannot be read."
    echo "DATA_KEYS=1:$(head -c 32 /dev/urandom | base64)"
    echo "ANTHROPIC_API_KEY="
    echo "MODEL=claude-haiku-5-5"
    if [ -n "$DOMAIN" ]; then
      echo "APP_URL=https://$DOMAIN"
      echo "APP_ORIGINS=https://$DOMAIN"
      echo "COOKIE_SECURE=true"
    else
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
  printf '%s {\n\treverse_proxy api:8787\n}\n' "$DOMAIN" > deploy/Caddyfile
  PROFILE=(--profile https)
else
  PROFILE=()
fi

# Reminders reach the phone through web push, which needs a key pair. Made once, kept in .env.
if ! grep -q '^VAPID_PRIVATE_KEY=.' .env; then
  docker compose build api
  docker compose run --rm --no-deps -T api node dist/cli/vapid.js >> .env
  if [ -n "$DOMAIN" ]; then echo "VAPID_SUBJECT=https://$DOMAIN" >> .env; else echo "VAPID_SUBJECT=mailto:you@example.com" >> .env; fi
  echo "Added VAPID keys to .env (needed for push reminders). Set VAPID_SUBJECT to your real contact email or site if you change it."
fi

docker compose "${PROFILE[@]}" up -d --build
docker compose exec -T api node dist/cli/migrate.js
echo
echo "Up. Create the first (owner) account:"
echo "  docker compose exec api node dist/cli/create-owner.js you@example.com 'a long password' 'Your Name'"
