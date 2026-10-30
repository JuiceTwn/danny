#!/usr/bin/env bash
# Runs the real deploy scripts against a fake `docker` and `curl`, so the repair logic can be tested anywhere.
# (Real containers are covered by test/integration.sh, which needs a Docker daemon.)   Run: bash deploy/test/scripts.test.sh
set -uo pipefail
exec < /dev/null   # deterministic stdin: nothing in here may depend on how the test was launched
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(dirname "$HERE")"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state" "$T/backups" "$T/repo/deploy"
cp "$DEPLOY"/*.sh "$DEPLOY/danny" "$T/repo/deploy/"
printf 'DATA_KEYS=1:abc\nANTHROPIC_API_KEY=sk\nVAPID_PRIVATE_KEY=v\nAPP_URL=http://localhost:8787\n' > "$T/repo/.env"

cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  info) [ -z "${FAKE_DOCKER_DOWN:-}" ]; exit $? ;;
  image|builder) exit 0 ;;
esac
shift   # compose
case "$1" in
  build) [ -z "${FAKE_BUILD_FAIL:-}" ] || exit 1 ;;
  ps) printf 'db|running|healthy\napi|running|healthy\n' ;;
  exec)
    case "$*" in
      *pg_dump*)
        [ -z "${FAKE_DUMP_FAIL:-}" ] || exit 1
        head -c 4000 /dev/urandom | base64 -w0; echo
        [ -n "${FAKE_DUMP_TRUNCATED:-}" ] || echo "-- PostgreSQL database dump complete" ;;
      *" -c "*) ;;                 # psql -c "..." does not read stdin
      *) cat > /dev/null ;;        # loading a dump does
    esac ;;
esac
exit 0
STUB
cat > "$T/bin/curl" <<'STUB'
#!/usr/bin/env bash
[ "${FAKE_HEALTHY:-0}" = 1 ] || exit 22
case "$*" in *readyz*) echo '{"ok":true,"db":true,"scheduler":true}' ;; esac
STUB
chmod +x "$T/bin"/*
export PATH="$T/bin:$PATH" FAKE_LOG="$T/log" DANNY_STATE_DIR="$T/state" DANNY_BACKUP_DIR="$T/backups"
export DANNY_DIR="$T/repo" DANNY_POLL_SECONDS=0 DANNY_WATCHDOG_COOLDOWN=0
S="$T/repo/deploy"

pass=0; failed=0
check() { # check "name" <command...>
  local name="$1"; shift
  if "$@"; then pass=$((pass + 1)); printf '  ok   %s\n' "$name"; else failed=$((failed + 1)); printf '  FAIL %s\n' "$name"; fi
}
reset() { : > "$FAKE_LOG"; rm -rf "$T/state"/* "$T/backups"/*; unset FAKE_HEALTHY FAKE_DOCKER_DOWN FAKE_DUMP_FAIL FAKE_DUMP_TRUNCATED FAKE_BUILD_FAIL DANNY_SKIP_SAFETY_BACKUP; }
logged() { grep -q -- "$1" "$FAKE_LOG"; }
not_logged() { ! grep -q -- "$1" "$FAKE_LOG"; }
# A healthy-flag file the fake curl cannot see is simpler than env juggling: the scenarios below set FAKE_HEALTHY per call.

echo "watchdog"
reset
FAKE_HEALTHY=1 "$S/watchdog.sh" >/dev/null
check "healthy: does nothing" not_logged "compose"
reset
FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null; FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null
check "two bad checks: stays patient (a blip or a deploy is not an outage)" not_logged "compose up"
FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null
check "third bad check: repair 1 brings the stack up" logged "compose up -d"
check "repair 1 does not restart anything yet" not_logged "compose restart"
FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null
check "still bad: repair 2 restarts the API" logged "compose restart api"
FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null
check "still bad: repair 3 restarts the database" logged "compose restart db"
FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null; rc=$?
check "after three repairs it gives up, loudly, and exits non-zero" test "$rc" -eq 1 -a -e "$T/state/watchdog.gave_up"
: > "$FAKE_LOG"
FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null
check "once given up it stops touching things (no restart loop)" test ! -s "$FAKE_LOG"
FAKE_HEALTHY=1 "$S/watchdog.sh" >/dev/null
check "when healthy again it clears its state" test ! -e "$T/state/watchdog.gave_up" -a ! -e "$T/state/watchdog.attempts"
reset
export DANNY_WATCHDOG_COOLDOWN=3600
for _ in 1 2 3 4 5; do FAKE_HEALTHY=0 "$S/watchdog.sh" >/dev/null; done
check "cooldown: repairs are spaced out, not back to back" test "$(grep -c 'compose up -d' "$FAKE_LOG")" -eq 1 -a "$(grep -c 'compose restart' "$FAKE_LOG")" -eq 0
export DANNY_WATCHDOG_COOLDOWN=0
reset
FAKE_DOCKER_DOWN=1 FAKE_HEALTHY=0 bash -c 'for _ in 1 2 3; do "$0"; done' "$S/watchdog.sh" >/dev/null 2>&1
check "docker down is noticed too (it still tries the repair)" logged "compose up -d"

echo "backup"
reset
"$S/backup.sh" >/dev/null; rc=$?
f="$(find "$T/backups" -name "danny-*.sql.gz" | head -1)"
check "writes a verified backup" test "$rc" -eq 0 -a -n "$f"
check "backup is private (600)" test "$(stat -c %a "$f")" = 600
check "no partial files left behind" test -z "$(find "$T/backups" -name ".partial-*")"
reset
FAKE_DUMP_FAIL=1 "$S/backup.sh" >/dev/null 2>&1; rc=$?
check "a failed dump fails the backup and leaves nothing" test "$rc" -ne 0 -a -z "$(ls -A "$T/backups")"
reset
FAKE_DUMP_TRUNCATED=1 "$S/backup.sh" >/dev/null 2>&1; rc=$?
check "a dump missing its end marker is rejected, not kept" test "$rc" -ne 0 -a -z "$(ls -A "$T/backups")"
reset
touch -d '20 days ago' "$T/backups/danny-20260101-000000.sql.gz"; touch -d '2 days ago' "$T/backups/danny-20260120-000000.sql.gz"
"$S/backup.sh" >/dev/null
check "retention: deletes backups older than 14 days, keeps recent ones" test ! -e "$T/backups/danny-20260101-000000.sql.gz" -a -e "$T/backups/danny-20260120-000000.sql.gz"

echo "restore"
reset
"$S/restore.sh" "$T/nope.gz" --yes >/dev/null 2>&1; rc=$?
check "refuses a file that does not exist" test "$rc" -ne 0 -a ! -s "$FAKE_LOG"
echo "not gzip" > "$T/bad.gz"; : > "$FAKE_LOG"
"$S/restore.sh" "$T/bad.gz" --yes >/dev/null 2>&1; rc=$?
check "refuses a corrupt backup before touching anything" test "$rc" -ne 0 -a ! -s "$FAKE_LOG"
"$S/backup.sh" >/dev/null; good="$(find "$T/backups" -name "danny-*.sql.gz" | head -1)"; : > "$FAKE_LOG"
FAKE_HEALTHY=1 "$S/restore.sh" "$good" --yes >/dev/null; rc=$?
order="$(grep -n -E 'compose (stop api|exec -T db psql.*DROP|exec -T db psql.*CREATE|exec -T db psql -U postgres -d danny -v ON_ERROR_STOP=1 -q -o|exec -T db psql.*GRANT|up -d api)' "$FAKE_LOG" | sed -E 's/^[0-9]+:docker compose //' | cut -d' ' -f1-3 | tr '\n' ';')"
check "restore: safety backup, stop API, drop, create, load, grant, start API (in that order)" test "$rc" -eq 0 -a "$(grep -c pg_dump "$FAKE_LOG")" -eq 1 -a "$order" = "stop api;exec -T db;exec -T db;exec -T db;exec -T db;up -d api;"
: > "$FAKE_LOG"
n_before="$(find "$T/backups" -type f | wc -l)"
printf 'wrong\n' | "$S/restore.sh" "$good" >/dev/null 2>&1; rc=$?
check "without --yes it needs the word 'restore', and cancels otherwise" test "$rc" -ne 0 -a ! -s "$FAKE_LOG" -a "$(find "$T/backups" -type f | wc -l)" -eq "$n_before"

echo "doctor"
reset
FAKE_HEALTHY=1 "$S/backup.sh" >/dev/null
FAKE_HEALTHY=1 "$S/doctor.sh" > "$T/doc.out" 2>&1; rc=$?
check "all good: exit 0" test "$rc" -eq 0
check "says the database and scheduler are fine" grep -q "scheduler is ticking" "$T/doc.out"
FAKE_HEALTHY=0 "$S/doctor.sh" > "$T/doc.out" 2>&1; rc=$?
check "not answering: exit 1 and says so" test "$rc" -eq 1 && grep -q "does not answer" "$T/doc.out"
sed -i '/^DATA_KEYS=/d' "$T/repo/.env"
FAKE_HEALTHY=1 "$S/doctor.sh" > "$T/doc.out" 2>&1; rc=$?
check "missing DATA_KEYS is a failure" test "$rc" -eq 1 && grep -q "DATA_KEYS is empty" "$T/doc.out"
printf 'DATA_KEYS=1:abc\n' >> "$T/repo/.env"
rm -f "$T/backups"/*
FAKE_HEALTHY=1 "$S/doctor.sh" > "$T/doc.out" 2>&1; rc=$?
check "no backups at all is a failure" test "$rc" -eq 1 && grep -q "no backups yet" "$T/doc.out"
touch "$T/state/watchdog.gave_up"; FAKE_HEALTHY=1 "$S/backup.sh" >/dev/null
FAKE_HEALTHY=1 "$S/doctor.sh" --fix > "$T/doc.out" 2>&1
check "--fix clears the watchdog's 'gave up' flag" test ! -e "$T/state/watchdog.gave_up"

echo "update"
# Real git (a local bare "origin"), fake docker. The server is a clone that carries the deploy scripts.
reset
G="$T/git"; rm -rf "$G"; mkdir -p "$G"
git init -q --bare -b main "$G/origin.git"
git clone -q "$G/origin.git" "$G/work" 2>/dev/null
gw() { git -C "$G/work" -c user.email=t@t -c user.name=t "$@"; }
gs() { git -C "$G/server" -c user.email=t@t -c user.name=t "$@"; }
publish() { echo "$1" > "$G/work/VERSION"; gw add -A >/dev/null; gw commit -qm "$1"; gw push -q origin HEAD:main 2>/dev/null; }
mkdir "$G/work/deploy"; cp "$DEPLOY"/*.sh "$DEPLOY/danny" "$G/work/deploy/"; publish v1
git clone -q "$G/origin.git" "$G/server" 2>/dev/null
OLD_DIR="$DANNY_DIR"; export DANNY_DIR="$G/server"
U="$G/server/deploy/update.sh"
head_of() { git -C "$G/server" rev-parse HEAD; }

: > "$FAKE_LOG"; FAKE_HEALTHY=1 "$U" > "$T/u.out" 2>&1
check "already up to date: says so and touches nothing" bash -c "grep -q 'Already up to date' '$T/u.out' && [ ! -s '$FAKE_LOG' ]"

publish v2
: > "$FAKE_LOG"; FAKE_HEALTHY=1 "$U" > "$T/u.out" 2>&1; rc=$?
check "update: moves to the new commit and ends healthy" test "$rc" -eq 0 -a "$(cat "$G/server/VERSION")" = v2 && grep -q "Updated and healthy" "$T/u.out"
seq="$(grep -E 'pg_dump|compose build api|migrate.js|compose up -d' "$FAKE_LOG" | sed -E 's/.*(pg_dump|build api|migrate\.js|up -d).*/\1/' | tr '\n' ' ')"
check "update order: backup, build, migrate, start" test "$seq" = "pg_dump build api migrate.js up -d "

publish v3; v2="$(head_of)"
: > "$FAKE_LOG"; FAKE_BUILD_FAIL=1 FAKE_HEALTHY=1 "$U" > "$T/u.out" 2>&1; rc=$?
check "build fails: the old code is put back, and it says so" test "$rc" -eq 1 -a "$(head_of)" = "$v2" -a "$(cat "$G/server/VERSION")" = v2 && grep -q "Putting the old code back" "$T/u.out"
check "build fails: the old version is rebuilt and started" logged "compose up -d --build api"

: > "$FAKE_LOG"; FAKE_HEALTHY=0 "$U" > "$T/u.out" 2>&1; rc=$?
check "new version never turns healthy: rolled back, and honest that the rollback is unhealthy too" test "$rc" -eq 1 -a "$(head_of)" = "$v2" && grep -q "Rollback is not healthy either" "$T/u.out"

echo dirty >> "$G/server/VERSION"
: > "$FAKE_LOG"; FAKE_HEALTHY=1 "$U" > "$T/u.out" 2>&1; rc=$?
check "local changes to tracked files: refuses before doing anything" test "$rc" -ne 0 -a ! -s "$FAKE_LOG" && grep -q "local changes" "$T/u.out"
gs checkout -q -- VERSION

gs commit -q --allow-empty -m "local only"; local_head="$(head_of)"
: > "$FAKE_LOG"; FAKE_HEALTHY=1 "$U" > "$T/u.out" 2>&1; rc=$?
check "history diverged: refuses to merge or rewrite, and leaves the checkout alone" test "$rc" -ne 0 -a "$(head_of)" = "$local_head"
gs reset -q --hard "$v2"

gs checkout -q --detach
: > "$FAKE_LOG"; FAKE_HEALTHY=1 "$U" > "$T/u.out" 2>&1; rc=$?
check "detached HEAD: refuses" test "$rc" -ne 0 -a ! -s "$FAKE_LOG" && grep -q "detached" "$T/u.out"
export DANNY_DIR="$OLD_DIR"

echo "danny command"
check "help lists the commands" bash -c "'$S/danny' help | grep -q 'danny update'"

echo
echo "$pass passed, $failed failed"
[ "$failed" -eq 0 ]
