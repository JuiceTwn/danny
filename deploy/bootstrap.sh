#!/usr/bin/env bash
# Turns a fresh Ubuntu or Debian server into a running Danny, installing what it needs.
#   sudo ./deploy/bootstrap.sh app.example.com    HTTPS on that domain (point its DNS A record at this server first)
#   sudo ./deploy/bootstrap.sh                    plain HTTP on port 8787, for trying it out
# Flags: --skip-dns-check  --no-firewall
# Safe to run again: every step checks before it acts.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$DIR/common.sh"

DOMAIN=""; SKIP_DNS=0; FIREWALL=1
for a in "$@"; do
  case "$a" in
    --skip-dns-check) SKIP_DNS=1 ;;
    --no-firewall) FIREWALL=0 ;;
    -*) die "unknown flag: $a" ;;
    *) DOMAIN="$a" ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

preflight() {
  step "Checking this server"
  [ "$(id -u)" -eq 0 ] || die "run as root: sudo ./deploy/bootstrap.sh ..."
  [ -r /etc/os-release ] || die "cannot tell which OS this is"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in ubuntu|debian) ;; *) die "this installer supports Ubuntu and Debian, not ${ID:-unknown}. Install Docker yourself, then run ./setup.sh" ;; esac
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "unsupported CPU: $(uname -m)" ;; esac
  free_gb="$(df --output=avail -BG / | tail -1 | tr -dc '0-9')"
  [ "${free_gb:-0}" -ge 8 ] || die "only ${free_gb}G free on /. Danny needs at least 8G (building the images takes space)"
  say "  $PRETTY_NAME, $(uname -m), ${free_gb}G free"

  if [ -n "$DOMAIN" ]; then
    # Anything already on 80/443 that is not Docker would stop the HTTPS certificate from being issued.
    other="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true)"
    [ -z "$other" ] || die "something else is already listening on port 80 or 443 (a web server like nginx or apache?). Stop it first:
$other"
    if [ "$SKIP_DNS" -eq 0 ]; then
      resolved="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')"
      [ -n "$resolved" ] || die "$DOMAIN does not resolve yet. Add an A record pointing at this server, wait a few minutes, and run this again."
      mine="$(curl -4 -fsS -m 8 https://api.ipify.org 2>/dev/null || true)"
      if [ -n "$mine" ] && [ "$resolved" != "$mine" ]; then
        die "$DOMAIN points at $resolved but this server is $mine. Fix the A record (or pass --skip-dns-check if you know better). Getting this wrong can get you rate-limited by the certificate authority."
      fi
      say "  $DOMAIN resolves to ${resolved}"
    fi
  fi
}

install_docker() {
  step "Docker"
  if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then say "  already installed"; return; fi
  # shellcheck disable=SC1091
  . /etc/os-release
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker compose version >/dev/null || die "Docker installed but 'docker compose' does not work"
}

add_swap() {
  step "Memory"
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  swap_mb="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
  if [ "$mem_mb" -ge 2000 ] || [ "$swap_mb" -gt 0 ]; then say "  ${mem_mb} MB RAM, ${swap_mb} MB swap: fine"; return; fi
  say "  ${mem_mb} MB RAM and no swap. Adding 2G of swap so builds do not run out of memory."
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

firewall() {
  step "Firewall"
  if [ "$FIREWALL" -eq 0 ]; then say "  skipped (--no-firewall)"; return; fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y ufw
  ssh_port="$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}')"; ssh_port="${ssh_port:-22}"
  # SSH is allowed BEFORE the firewall is switched on, so this can never lock you out.
  ufw allow "$ssh_port/tcp" >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  say "  open: SSH ($ssh_port), 80, 443. Everything else is closed."
  say "  (If your host has its own firewall in its control panel, make sure it allows the same ports.)"
}

security_updates() {
  step "Automatic security updates"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y unattended-upgrades
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  say "  security patches install themselves. The server does NOT reboot by itself: reboot now and then (Danny restarts on his own)."
}

run_setup() {
  step "Building and starting Danny (the first build takes a few minutes)"
  (cd "$DANNY_DIR" && ./setup.sh ${DOMAIN:+"$DOMAIN"})
}

install_services() {
  step "Watchdog, nightly backups and the 'danny' command"
  mkdir -p "$STATE_DIR" "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  ln -sf "$DIR/danny" /usr/local/bin/danny
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl list-units >/dev/null 2>&1; then
    say "  systemd is not available here, so the timers were not installed. Run $DIR/watchdog.sh every minute and $DIR/backup.sh nightly from cron."
    return
  fi
  cat > /etc/systemd/system/danny-watchdog.service <<UNIT
[Unit]
Description=Danny watchdog: repair Danny if he stops answering
After=docker.service
[Service]
Type=oneshot
ExecStart=$DIR/watchdog.sh
UNIT
  cat > /etc/systemd/system/danny-watchdog.timer <<UNIT
[Unit]
Description=Run the Danny watchdog every minute
[Timer]
OnBootSec=3min
OnUnitActiveSec=1min
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
  cat > /etc/systemd/system/danny-backup.service <<UNIT
[Unit]
Description=Back up Danny's database
After=docker.service
[Service]
Type=oneshot
ExecStart=$DIR/backup.sh
UNIT
  cat > /etc/systemd/system/danny-backup.timer <<UNIT
[Unit]
Description=Back up Danny's database every night
[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=10min
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now danny-watchdog.timer danny-backup.timer
  say "  watchdog: every minute. backup: every night at about 03:17, 14 days kept in $BACKUP_DIR"
}

preflight
install_docker
add_swap
firewall
security_updates
run_setup
install_services

step "Checking that everything is healthy"
wait_healthy 120 || true
"$DIR/backup.sh" || true
"$DIR/doctor.sh" || true

if [ -n "$DOMAIN" ]; then
  MONITOR="  4. Optional but worth it: a free outside monitor (UptimeRobot, Better Stack) on https://$DOMAIN/healthz
     so you hear about it if the whole server goes down. The watchdog can't tell you that, because it dies with the server."
else
  MONITOR="  4. No domain was given, so Danny is only reachable from this server. From your own computer:
     ssh -L 8787:localhost:8787 you@this-server   then open http://localhost:8787"
fi

cat <<DONE

Next:
  1. Create your account:   docker compose exec api node dist/cli/create-owner.js you@example.com 'a long password' 'Your Name'
  2. Add your keys to .env (ANTHROPIC_API_KEY, and the Google ones for Gmail), then: docker compose up -d
  3. Copy DATA_KEYS from .env to a password manager. If it is lost, your data cannot be read, even from a backup.
$MONITOR
Looking after it later:  danny doctor | danny backup | danny update | danny logs
DONE
