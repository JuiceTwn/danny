#!/usr/bin/env bash
# Runs every minute (systemd timer). If Danny stays unhealthy it repairs him in escalating steps, then stops trying
# instead of thrashing, and says so loudly. Plain, predictable steps; it never edits code, config or data.
set -uo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

mkdir -p "$STATE_DIR"
fails_f="$STATE_DIR/watchdog.fails"; attempts_f="$STATE_DIR/watchdog.attempts"
last_f="$STATE_DIR/watchdog.last_repair"; gaveup_f="$STATE_DIR/watchdog.gave_up"
GRACE="${DANNY_WATCHDOG_GRACE:-3}"        # consecutive bad checks before acting (a deploy or a blip is not an outage)
COOLDOWN="${DANNY_WATCHDOG_COOLDOWN:-300}" # seconds between repair attempts
log() { logger -t danny-watchdog "$*" 2>/dev/null || true; say "$*"; }
read_n() { cat "$1" 2>/dev/null || echo 0; }

if healthy; then
  if [ -e "$attempts_f" ] || [ -e "$gaveup_f" ]; then log "healthy again"; fi
  rm -f "$fails_f" "$attempts_f" "$last_f" "$gaveup_f"
  exit 0
fi

n=$(( $(read_n "$fails_f") + 1 )); echo "$n" > "$fails_f"
[ "$n" -ge "$GRACE" ] || exit 0
[ ! -e "$gaveup_f" ] || exit 1           # already gave up: stay quiet until someone fixes it (danny doctor)
now="$(date +%s)"
[ $(( now - $(read_n "$last_f") )) -ge "$COOLDOWN" ] || exit 0

a=$(( $(read_n "$attempts_f") + 1 )); echo "$a" > "$attempts_f"; echo "$now" > "$last_f"
case "$a" in
  1)
    log "unhealthy for $n checks. Repair 1: make sure Docker is up, free disk if it is nearly full, bring the stack up"
    systemctl is-active --quiet docker 2>/dev/null || systemctl restart docker 2>/dev/null || true
    used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
    if [ "${used:-0}" -ge 92 ]; then docker image prune -f >/dev/null 2>&1; docker builder prune -f >/dev/null 2>&1; fi
    compose up -d
    ;;
  2) log "still unhealthy. Repair 2: restart the API"; compose restart api ;;
  3) log "still unhealthy. Repair 3: restart the database, then the API"; compose restart db; sleep 5; compose restart api ;;
  *) log "GIVING UP after 3 repairs. Danny needs a person. Run: danny doctor"; touch "$gaveup_f"; exit 1 ;;
esac

if wait_healthy 90; then
  log "healthy again after repair $a"
  rm -f "$fails_f" "$attempts_f" "$last_f" "$gaveup_f"
else
  log "still unhealthy after repair $a"
fi
