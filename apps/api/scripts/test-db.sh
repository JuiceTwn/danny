#!/usr/bin/env bash
# Starts a throwaway Postgres on port 54329 for the test suite. Needs postgresql-16 installed.
set -euo pipefail
PGB=/usr/lib/postgresql/16/bin
DIR=${1:-/tmp/danny-pgdata}
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR"; chown postgres "$DIR" 2>/dev/null || true
  su postgres -c "$PGB/initdb -D $DIR -A trust -U postgres >/dev/null"
fi
su postgres -c "$PGB/pg_ctl -D $DIR -o '-p 54329 -k /tmp' -l /tmp/danny-pg.log -w start" || true
