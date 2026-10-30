#!/usr/bin/env bash
# Checks everything Danny depends on and says what is wrong in plain words: danny doctor
# Add --fix to also do the safe repairs (bring the stack up, free disk, clear the watchdog's "gave up" flag).
set -uo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

FIX=0; [ "${1:-}" = "--fix" ] && FIX=1
bad=0; warns=0
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; warns=$((warns + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; bad=$((bad + 1)); }

say "Danny doctor"

say "Docker"
if docker info >/dev/null 2>&1; then ok "Docker is running"; else fail "Docker is not running. Try: systemctl restart docker"; fi

say "Containers"
ps_out="$(compose ps --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null || true)"
for svc in db api; do
  line="$(printf '%s\n' "$ps_out" | grep "^$svc|" | head -1)"
  state="$(printf '%s' "$line" | cut -d'|' -f2)"; health="$(printf '%s' "$line" | cut -d'|' -f3)"
  if [ "$state" = "running" ] && { [ -z "$health" ] || [ "$health" = "healthy" ]; }; then ok "$svc is running${health:+ and $health}"
  elif [ "$state" = "running" ]; then warn "$svc is running but $health"
  else fail "$svc is not running (${state:-missing}). Try: danny doctor --fix"; fi
done

say "Readiness"
ready="$(curl -s -m 5 "$LOCAL_URL/readyz" 2>/dev/null || true)"
if [ -z "$ready" ]; then fail "the API does not answer on $LOCAL_URL"
elif printf '%s' "$ready" | grep -q '"ok":true'; then ok "database answers and the reminder scheduler is ticking"
else
  printf '%s' "$ready" | grep -q '"db":false' && fail "the database is not answering"
  printf '%s' "$ready" | grep -q '"scheduler":false' && fail "the reminder scheduler has stopped (reminders would not fire). Restart the API: docker compose restart api"
fi

say "Settings (.env)"
if [ ! -f "$DANNY_DIR/.env" ]; then fail ".env is missing. Run ./setup.sh"; else
  if [ -n "$(env_get DATA_KEYS)" ]; then ok "DATA_KEYS is set (keep a copy somewhere that is NOT this server or the backups)"; else fail "DATA_KEYS is empty: nothing can be decrypted"; fi
  if [ -n "$(env_get ANTHROPIC_API_KEY)" ]; then ok "ANTHROPIC_API_KEY is set"; else warn "ANTHROPIC_API_KEY is empty: Danny is in demo mode"; fi
  if [ -n "$(env_get VAPID_PRIVATE_KEY)" ]; then ok "push keys are set"; else warn "push keys are missing: reminders will not buzz your phone (they still show in the chat)"; fi
  if [ -n "$(env_get GOOGLE_CLIENT_ID)" ]; then ok "Gmail is configured"; else say "  info  Gmail is not configured (optional, see docs/GMAIL_SETUP.md)"; fi
fi

say "Server"
used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if [ "${used:-0}" -ge 93 ]; then fail "disk is ${used}% full"; elif [ "${used:-0}" -ge 85 ]; then warn "disk is ${used}% full"; else ok "disk is ${used}% full"; fi
mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"; swap_mb="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "$mem_mb" -lt 1500 ] && [ "$swap_mb" -eq 0 ]; then warn "${mem_mb} MB RAM and no swap: builds can run out of memory"; else ok "memory ${mem_mb} MB, swap ${swap_mb} MB"; fi

say "Backups"
newest="$(find "$BACKUP_DIR" -name 'danny-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$newest" ]; then fail "no backups yet. Run: danny backup"
else
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  if [ "$age_h" -gt 36 ]; then warn "newest backup is ${age_h} hours old ($newest)"; else ok "newest backup is ${age_h} hours old"; fi
fi

say "Watchdog"
if [ -e "$STATE_DIR/watchdog.gave_up" ]; then fail "the watchdog gave up after 3 repairs. Fix the cause, then: danny doctor --fix"
else ok "watchdog has not given up"; fi
if command -v systemctl >/dev/null 2>&1 && systemctl list-units >/dev/null 2>&1; then
  for t in danny-watchdog danny-backup; do
    if systemctl is-active --quiet "$t.timer"; then ok "$t timer is active"; else warn "$t timer is not active (re-run deploy/bootstrap.sh)"; fi
  done
fi

app_url="$(env_get APP_URL)"
case "$app_url" in
  https://*)
    say "HTTPS"
    host="${app_url#https://}"; host="${host%%/*}"
    end="$(echo | timeout 8 openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -z "$end" ]; then warn "could not read the certificate for $host (DNS or port 443?)"
    else
      days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
      if [ "$days" -lt 7 ]; then fail "certificate for $host expires in $days days (Caddy should renew by itself: check its logs)"; else ok "certificate for $host is good for $days more days"; fi
    fi ;;
esac

if [ "$FIX" = 1 ]; then
  say "Fixing"
  compose up -d && say "  stack brought up"
  docker image prune -f >/dev/null 2>&1 && say "  unused images removed"
  rm -f "$STATE_DIR/watchdog.gave_up" "$STATE_DIR/watchdog.attempts" "$STATE_DIR/watchdog.fails" "$STATE_DIR/watchdog.last_repair" && say "  watchdog reset"
  if [ -z "$newest" ] || [ "${age_h:-0}" -gt 36 ]; then "$(dirname "${BASH_SOURCE[0]}")/backup.sh" || true; fi
fi

say ""
say "$bad problem(s), $warns warning(s)."
exit $(( bad > 0 ? 1 : 0 ))
