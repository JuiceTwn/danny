#!/usr/bin/env bash
# Database backup: a gzipped SQL dump, checked, kept for 14 days. Runs nightly (systemd timer) or by hand: danny backup
# The dump keeps memory, messages and drafts encrypted (the key is NOT in it). Back up DATA_KEYS separately, never next to it.
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

KEEP_DAYS="${DANNY_BACKUP_KEEP_DAYS:-14}"
umask 077
mkdir -p "$BACKUP_DIR"
ts="${DANNY_BACKUP_TS:-$(date -u +%Y%m%d-%H%M%S)}"   # DANNY_BACKUP_TS is for tests
tmp="$BACKUP_DIR/.partial-$ts-$$.sql.gz"
# Never overwrite an existing backup. Two backups in the same second (a restore's safety backup right after one you just
# took, for example) must both survive: restoring file X must not replace X with the state you are about to discard.
final="$BACKUP_DIR/danny-$ts.sql.gz"; n=1
while [ -e "$final" ]; do final="$BACKUP_DIR/danny-$ts-$n.sql.gz"; n=$((n + 1)); done
trap 'rm -f "$tmp"' EXIT

# pipefail makes a failed pg_dump fail the whole line instead of leaving a truncated file that looks fine.
compose exec -T db pg_dump -U postgres -d danny | gzip -9 > "$tmp"

# A backup you have not checked is a hope, not a backup.
gzip -t "$tmp" || die "backup file is corrupt"
[ "$(stat -c %s "$tmp")" -gt 2000 ] || die "backup is suspiciously small"
gunzip -c "$tmp" | tail -5 | grep -q "PostgreSQL database dump complete" || die "backup is incomplete"

mv "$tmp" "$final"
find "$BACKUP_DIR" -name 'danny-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
say "backup ok: $final ($(du -h "$final" | cut -f1))"
