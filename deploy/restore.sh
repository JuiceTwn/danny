#!/usr/bin/env bash
# Replace the database with a backup: danny restore /var/backups/danny/danny-....sql.gz
# It takes a safety backup of what is there first (unless DANNY_SKIP_SAFETY_BACKUP=1, for when the database is too broken to dump).
set -euo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
. "$DIR/common.sh"

file="${1:-}"
[ -f "$file" ] || die "usage: danny restore <backup file> [--yes]   (backups are in $BACKUP_DIR)"
gzip -t "$file" || die "that backup file is corrupt"

if [ "${2:-}" != "--yes" ]; then
  say "This REPLACES everything in Danny's database with: $file"
  read -r -p "Type 'restore' to continue: " answer
  [ "$answer" = "restore" ] || die "cancelled"
fi

if [ "${DANNY_SKIP_SAFETY_BACKUP:-0}" != "1" ]; then
  say "Taking a safety backup first..."
  "$DIR/backup.sh"
fi

compose stop api
compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS danny WITH (FORCE)"
compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE danny OWNER danny_owner"
gunzip -c "$file" | compose exec -T db psql -U postgres -d danny -v ON_ERROR_STOP=1 -q -o /dev/null
# Database-level grants are not part of a dump.
compose exec -T db psql -U postgres -d danny -v ON_ERROR_STOP=1 -q -c "GRANT CONNECT ON DATABASE danny TO danny_app" -c "GRANT USAGE ON SCHEMA public TO danny_app"
compose up -d api
if wait_healthy 90; then say "restored and healthy."; else die "restored, but Danny is not healthy. Run: danny doctor"; fi
