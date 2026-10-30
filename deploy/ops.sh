#!/usr/bin/env bash
# Does what the Owner tab asks for, so nobody has to SSH in: check for updates, back up, update.
# The app only drops an empty file named "check", "backup" or "update" in the requests folder. This script, which runs as
# root on the server, looks at those three names and nothing else: it never reads what is inside a request, and it
# ignores any other name, any link, any folder. The app never gets Docker, a shell or the repo.
# Triggered by the systemd path unit that `danny ops-install` sets up. Safe to run by hand: danny ops
set -uo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
. "$DIR/common.sh"

OPS="$STATE_DIR/ops"; REQ="$OPS/requests"; OUT="$OPS/status"
mkdir -p "$REQ" "$OUT"

# One thing at a time, and the watchdog stays out of the way while this holds the lock.
exec 9>"$STATE_DIR/ops.lock"
flock -n 9 || exit 0

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Plain text in, JSON string contents out: no control characters, backslashes and quotes escaped, one line.
jesc() { tr -d '\000-\010\013-\037' | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/ /g' | awk 'BEGIN{ORS=""} {printf "%s\\n", $0}'; }

write_atomic() { # write_atomic <file>  (content on stdin)
  local tmp; tmp="$(mktemp "$OUT/.tmp.XXXXXX")" || return 1
  cat > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$1"
}

write_last() { # write_last <action> <state> <started> <finished> <summary-file>
  local summary="" fin="null"
  [ -f "$5" ] && summary="$(tail -n 12 "$5" | jesc)"
  [ -z "$4" ] || fin="\"$4\""
  printf '{"action":"%s","state":"%s","startedAt":"%s","finishedAt":%s,"summary":"%s"}\n' "$1" "$2" "$3" "$fin" "$summary" | write_atomic "$OUT/last.json"
}

write_backups() {
  local first=1 f
  {
    printf '['
    # shellcheck disable=SC2012  # file names are ours (danny-<timestamp>.sql.gz), and newest-first is what we want
    for f in $(ls -1t "$BACKUP_DIR"/danny-*.sql.gz 2>/dev/null | head -5); do
      [ "$first" = 1 ] || printf ','
      first=0
      printf '{"name":"%s","bytes":%s,"at":"%s"}' "$(basename "$f")" "$(stat -c %s "$f")" "$(date -u -d "@$(stat -c %Y "$f")" +%Y-%m-%dT%H:%M:%SZ)"
    done
    printf ']\n'
  } | write_atomic "$OUT/backups.json"
}

write_repo() {
  cd "$DANNY_DIR" || return
  local branch behind=0 changes="" first=1 s
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
    behind="$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)"
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      [ "$first" = 1 ] || changes="$changes,"
      first=0
      changes="$changes\"$(printf '%s' "$s" | cut -c1-120 | jesc | sed 's/\\n$//')\""
    done < <(git log --format=%s -n 10 "HEAD..origin/$branch" 2>/dev/null)
  fi
  printf '{"version":"%s","branch":"%s","behind":%s,"changes":[%s],"checkedAt":"%s"}\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" "$branch" "$behind" "$changes" "$(now)" | write_atomic "$OUT/repo.json"
}

run_action() { # run_action <name>
  local action="$1" started log rc=0; started="$(now)"; log="$(mktemp)"
  write_last "$action" running "$started" "" /dev/null
  case "$action" in
    check)
      (cd "$DANNY_DIR" && git fetch --quiet origin "$(git rev-parse --abbrev-ref HEAD)") >"$log" 2>&1 || rc=$?
      [ "$rc" -ne 0 ] || say "Checked for updates." >"$log" ;;
    backup) "$DIR/backup.sh" >"$log" 2>&1 || rc=$? ;;
    update) DANNY_FROM_OPS=1 "$DIR/update.sh" >"$log" 2>&1 || rc=$? ;;
  esac
  write_backups; write_repo
  write_last "$action" "$([ "$rc" -eq 0 ] && echo ok || echo failed)" "$started" "$(now)" "$log"
  logger -t danny-ops "$action: exit $rc" 2>/dev/null || true
  rm -f "$log"
}

# Order matters: look first, then back up, then update.
for action in check backup update; do
  f="$REQ/$action"
  if [ -L "$f" ] || [ ! -f "$f" ]; then continue; fi
  rm -f -- "$f"
  run_action "$action"
done
# Anything else in the folder is not ours to run. Clear it so a stray file cannot keep re-triggering the path unit.
find "$REQ" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null
write_backups; write_repo
exit 0
