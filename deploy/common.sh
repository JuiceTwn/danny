#!/usr/bin/env bash
# Shared helpers. Sourced by the other scripts in this folder; not run on its own.
# shellcheck disable=SC2034  # the next three are used by the scripts that source this file
DANNY_DIR="${DANNY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${DANNY_STATE_DIR:-/var/lib/danny}"
BACKUP_DIR="${DANNY_BACKUP_DIR:-/var/backups/danny}"
LOCAL_URL="${DANNY_LOCAL_URL:-http://127.0.0.1:8787}"

say()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
compose() { (cd "$DANNY_DIR" && docker compose "$@"); }

# Value of KEY in .env, or empty.
env_get() {
  if [ -f "$DANNY_DIR/.env" ]; then grep -E "^$1=" "$DANNY_DIR/.env" | head -1 | cut -d= -f2- || true; fi
}

# Ready means the database answers and the reminder scheduler is ticking (see /readyz in the API).
healthy() { curl -fsS -m 5 "$LOCAL_URL/readyz" >/dev/null 2>&1; }

# wait_healthy [seconds]: true as soon as it is ready, false if it never is.
wait_healthy() {
  local limit="${1:-60}" step="${DANNY_POLL_SECONDS:-3}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    healthy && return 0
    sleep "$step"
    waited=$((waited + (step > 0 ? step : 1)))  # step 0 is for tests: still make progress
  done
  return 1
}
