#!/usr/bin/env bash
# Real containers. Starts the stack exactly the way setup.sh does, then breaks it on purpose and checks it heals:
#   first-run setup, readiness, owner login, backup, restore (and that logins still work after it), watchdog repair.
# Needs a Docker daemon and free port 8787.   Run: bash deploy/test/integration.sh
# To reuse an image you already built:  DANNY_IT_IMAGE=danny-api:test bash deploy/test/integration.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
W="$(mktemp -d)"; PROJECT=dannyit
export COMPOSE_PROJECT_NAME="$PROJECT" DANNY_DIR="$W/repo" DANNY_STATE_DIR="$W/state" DANNY_BACKUP_DIR="$W/backups" DANNY_POLL_SECONDS=2
export DANNY_WATCHDOG_GRACE=1 DANNY_WATCHDOG_COOLDOWN=0
cleanup() { (cd "$W/repo" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1) || true; rm -rf "$W"; }
trap cleanup EXIT

pass=0; failed=0
check() { local n="$1"; shift; if "$@"; then pass=$((pass + 1)); printf '  ok   %s\n' "$n"; else failed=$((failed + 1)); printf '  FAIL %s\n' "$n"; fi; }

mkdir -p "$W/repo"
tar -C "$REPO" --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env -cf - . | tar -C "$W/repo" -xf -
if [ -n "${DANNY_IT_IMAGE:-}" ]; then docker tag "$DANNY_IT_IMAGE" "$PROJECT-api:latest"; export DANNY_NO_BUILD=1; fi
cd "$W/repo"

echo "first run (setup.sh)"
./setup.sh > "$W/setup.out" 2>&1 || { cat "$W/setup.out"; echo "setup.sh failed"; exit 1; }
check "setup.sh finished" grep -q "Up. Create the first" "$W/setup.out"
check ".env has a data key, push keys and Gmail placeholders" bash -c "grep -q '^DATA_KEYS=1:' .env && grep -q '^VAPID_PRIVATE_KEY=.' .env && grep -q '^GOOGLE_CLIENT_ID=' .env"
. "$HERE/../common.sh"
check "API reports ready (database up, scheduler ticking)" wait_healthy 90
check "container health status is 'healthy' (Dockerfile HEALTHCHECK uses /readyz)" bash -c 'for _ in $(seq 1 30); do [ "$(docker inspect -f "{{.State.Health.Status}}" "$(docker compose ps -q api)")" = healthy ] && exit 0; sleep 2; done; exit 1'
check "/healthz answers" curl -fsS -m 5 http://127.0.0.1:8787/healthz
check "log rotation is configured on the containers" bash -c 'docker inspect -f "{{.HostConfig.LogConfig.Config}}" "$(docker compose ps -q api)" | grep -q "max-size:10m"'

echo "using it"
docker compose exec -T api node dist/cli/create-owner.js owner@it.test 'a long password 123' Owner >/dev/null
JAR="$W/jar"; O=(-H "Origin: http://localhost:8787" -H "content-type: application/json")
api() { curl -fsS -m 10 -b "$JAR" -c "$JAR" "${O[@]}" "$@"; }
check "owner can log in (restricted database role + row-level security work in the real image)" api -X POST http://127.0.0.1:8787/v1/auth/login -d '{"email":"owner@it.test","password":"a long password 123"}'
api -X POST http://127.0.0.1:8787/v1/tasks -d '{"title":"survives the restore"}' >/dev/null
check "a task can be created" bash -c "curl -fsS -b '$JAR' http://127.0.0.1:8787/v1/tasks | grep -q 'survives the restore'"

echo "backup and restore"
"$HERE/../backup.sh" > "$W/backup.out"
good="$(find "$DANNY_BACKUP_DIR" -name 'danny-*.sql.gz' | head -1)"
check "backup file exists, is valid gzip and is private" bash -c "[ -n '$good' ] && gzip -t '$good' && [ \"\$(stat -c %a '$good')\" = 600 ]"
check "backup holds the schema and the row-level-security policies" bash -c "gunzip -c '$good' | grep -q 'CREATE POLICY tenant_isolation ON public.tasks'"
check "backup does not contain the task title in plain text (it is encrypted)" bash -c "! gunzip -c '$good' | grep -q 'survives the restore'"
api -X POST http://127.0.0.1:8787/v1/tasks -d '{"title":"added after the backup"}' >/dev/null
DANNY_SKIP_SAFETY_BACKUP=0 "$HERE/../restore.sh" "$good" --yes > "$W/restore.out" 2>&1 || { cat "$W/restore.out"; }
check "restore finishes healthy" grep -q "restored and healthy" "$W/restore.out"
rm -f "$JAR"
check "after the restore, login still works (grants and roles survived)" api -X POST http://127.0.0.1:8787/v1/auth/login -d '{"email":"owner@it.test","password":"a long password 123"}'
tasks="$(curl -fsS -b "$JAR" http://127.0.0.1:8787/v1/tasks)"
check "restore brought back the old data and dropped what came after" bash -c "echo '$tasks' | grep -q 'survives the restore' && ! echo '$tasks' | grep -q 'added after the backup'"
check "restore took a safety backup first" bash -c "[ \"\$(find '$DANNY_BACKUP_DIR' -name 'danny-*.sql.gz' | wc -l)\" -ge 2 ]"

echo "self-healing"
docker compose stop api >/dev/null 2>&1
check "with the API stopped, it is reported not ready" bash -c "! curl -fsS -m 3 http://127.0.0.1:8787/readyz"
"$HERE/../doctor.sh" > "$W/doctor.out" 2>&1 || true
check "doctor says the API is down" grep -q "api is not running" "$W/doctor.out"
"$HERE/../watchdog.sh" > "$W/wd.out" 2>&1 || true
check "watchdog brings it back and confirms it" bash -c "grep -q 'healthy again after repair 1' '$W/wd.out' && curl -fsS -m 5 http://127.0.0.1:8787/readyz"
docker compose stop db >/dev/null 2>&1
check "with the database stopped, /readyz is 503 and /healthz still says the process is alive" bash -c "[ \"\$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz)\" = 503 ] && curl -fsS -m 5 http://127.0.0.1:8787/healthz"
"$HERE/../watchdog.sh" > "$W/wd2.out" 2>&1 || true
check "watchdog recovers a stopped database too" bash -c "grep -q 'healthy again' '$W/wd2.out' && curl -fsS -m 5 http://127.0.0.1:8787/readyz"
"$HERE/../doctor.sh" > "$W/doctor2.out" 2>&1 || true
check "doctor is clean about the containers afterwards" bash -c "grep -q 'db is running' '$W/doctor2.out' && grep -q 'api is running' '$W/doctor2.out'"

echo
echo "$pass passed, $failed failed"
[ "$failed" -eq 0 ]
