#!/usr/bin/env bash
# Sets up the Owner tab's Update and Backup buttons: folders, and a systemd path unit that runs ops.sh the moment the app asks.
# Safe to run again. `danny update` runs it every time so the unit follows the code. Needs root.
set -euo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
. "$DIR/common.sh"

OPS="$STATE_DIR/ops"
mkdir -p "$STATE_DIR" "$BACKUP_DIR"
# requests: the one folder the app can write to (it runs as uid 1000 in the container). status: the app can only read it.
install -d -m 0755 -o root -g root "$OPS" "$OPS/status"
install -d -m 0700 -o 1000 -g 1000 "$OPS/requests"

if command -v systemctl >/dev/null 2>&1 && systemctl list-units >/dev/null 2>&1; then
  cat > /etc/systemd/system/danny-ops.service <<UNIT
[Unit]
Description=Do what the Danny Owner tab asked for (check, backup, update)
After=docker.service
[Service]
Type=oneshot
ExecStart=$DIR/ops.sh
TimeoutStartSec=30min
UNIT
  cat > /etc/systemd/system/danny-ops.path <<UNIT
[Unit]
Description=Watch for Owner tab requests
[Path]
PathExistsGlob=$OPS/requests/*
Unit=danny-ops.service
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now danny-ops.path
  say "Owner tab buttons are on. The app can now ask for a check, a backup or an update."
else
  say "systemd is not available here, so the buttons will not work. Run $DIR/ops.sh from cron every minute instead."
fi
"$DIR/ops.sh" || true   # fill in the status files so the tab has something to show straight away
