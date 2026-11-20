#!/usr/bin/env bash
# Brewie Web — one-file installer / updater for Raspberry Pi (Pi 3, 4, 5, Zero 2 W; Raspberry Pi OS / Debian).
#
#   Install or update:   sudo bash brewie-pi-install.sh
#   Unattended:          sudo bash brewie-pi-install.sh --yes --brewie 192.168.10.60 --port 8088
#   Copy data from Unraid during install:  --migrate root@192.168.10.249
#   Remove (keeps your data):              sudo bash brewie-pi-install.sh --uninstall
#
# Everything the app needs is embedded at the bottom of this file. Re-running a newer copy updates
# the app and keeps your recipes, settings and configuration.
set -euo pipefail

VERSION="__VERSION__"
APP_DIR=/opt/brewie-web
DATA_DIR=/var/lib/brewie-web
CONF=/etc/default/brewie-web
UNIT=/etc/systemd/system/brewie-web.service
SVC_USER=brewie
NODE_MAJOR=22

ASSUME_YES=0; BREWIE_HOST=""; PORT=""; TZ_SET=""; MIGRATE=""; UNINSTALL=0; EXTRACT_ONLY=""; NO_WIFI_FIX=0

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_b=$'\e[1m'; c_0=$'\e[0m'
step() { echo; echo "${c_b}==> $*${c_0}"; }
ok()   { echo "  ${c_ok}✓${c_0} $*"; }
warn() { echo "  ${c_warn}!${c_0} $*"; }
die()  { echo "${c_err}✗ $*${c_0}" >&2; exit 1; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --brewie IP      Brewie address (default: ask, or 192.168.10.60)
  --port N         Web port (default 8088)
  --tz ZONE        Time zone for log times (default: the Pi's own)
  --migrate USER@HOST
                   Copy recipes and settings from an existing Brewie Web on Unraid
                   (/mnt/user/appdata/brewie-web) before starting
  --no-wifi-fix    Don't turn off Wi-Fi power saving
  --yes, -y        Don't ask questions; use defaults / given options
  --uninstall      Remove the app and service (keeps $DATA_DIR)
  --version        Print the bundled Brewie Web version
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --brewie) BREWIE_HOST="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --tz) TZ_SET="${2:-}"; shift 2 ;;
    --migrate) MIGRATE="${2:-}"; shift 2 ;;
    --no-wifi-fix) NO_WIFI_FIX=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --extract-only) EXTRACT_ONLY="${2:-}"; shift 2 ;;
    --version) echo "$VERSION"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

extract_payload() { # $1 = target dir
  mkdir -p "$1"
  local line
  line=$(grep -an '^__PAYLOAD_BELOW__$' "$0" | tail -n1 | cut -d: -f1)
  [ -n "$line" ] || die "Installer is damaged (no payload found). Copy it to the Pi again."
  tail -n +"$((line + 1))" "$0" | base64 -d | tar -xz -C "$1"
}

if [ -n "$EXTRACT_ONLY" ]; then extract_payload "$EXTRACT_ONLY"; echo "Extracted Brewie Web $VERSION to $EXTRACT_ONLY"; exit 0; fi

[ "$(id -u)" -eq 0 ] || die "Run with sudo:  sudo bash $0"

ask() { # ask "Question" default -> echoes answer
  local q="$1" def="$2" a=""
  if [ "$ASSUME_YES" -eq 1 ] || [ ! -r /dev/tty ]; then echo "$def"; return; fi
  read -r -p "  $q [$def]: " a </dev/tty || true
  echo "${a:-$def}"
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  step "Removing Brewie Web"
  systemctl disable --now brewie-web 2>/dev/null || true
  rm -f "$UNIT"; systemctl daemon-reload
  rm -rf "$APP_DIR"
  ok "App and service removed. Your data is still in $DATA_DIR and settings in $CONF (delete them by hand if you want)."
  exit 0
fi

echo "${c_b}Brewie Web $VERSION — Raspberry Pi installer${c_0}"

# ---------------------------------------------------------------- checks
step "Checking this machine"
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64|x86_64) ok "CPU: $ARCH" ;;
  armv7l) warn "32-bit OS detected ($ARCH). It should work, but the 64-bit Raspberry Pi OS Lite is recommended." ;;
  armv6l) die "This is a Pi Zero / Pi 1 (armv6). Current Node.js doesn't run on it — use a Pi 3, 4, 5 or Zero 2 W." ;;
  *) warn "Untested CPU type: $ARCH" ;;
esac
command -v apt-get >/dev/null || die "This installer needs Raspberry Pi OS / Debian (apt)."
command -v systemctl >/dev/null || die "systemd is required."
MEM=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo); ok "Memory: ${MEM} MB"

# ---------------------------------------------------------------- configuration
UPDATING=0
conf_get() { sed -n "s/^$1=//p" "$CONF" 2>/dev/null | head -n1; }
if [ -f "$CONF" ]; then
  UPDATING=1
  ok "Existing install found — updating (your settings in $CONF are kept)"
fi
CUR_TZ=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)

if [ "$UPDATING" -eq 0 ]; then
  [ "$ASSUME_YES" -eq 1 ] || step "A few questions (press Enter to accept the default)"
  BREWIE_HOST=${BREWIE_HOST:-$(ask "Brewie IP address" "192.168.10.60")}
  PORT=${PORT:-$(ask "Web page port" "8088")}
  TZ_SET=${TZ_SET:-$(ask "Time zone" "$CUR_TZ")}
  if [ -z "$MIGRATE" ] && [ "$ASSUME_YES" -eq 0 ]; then
    m=$(ask "Copy recipes & settings from Unraid? Enter root@<unraid-ip>, or 'no'" "no")
    [ "$m" != "no" ] && MIGRATE="$m"
  fi
else
  CLI_HOST=$BREWIE_HOST; CLI_PORT=$PORT; CLI_TZ=$TZ_SET
  BREWIE_HOST=${BREWIE_HOST:-$(conf_get BREWIE_HOST)}; BREWIE_HOST=${BREWIE_HOST:-192.168.10.60}
  PORT=${PORT:-$(conf_get PORT)}; PORT=${PORT:-8088}
  TZ_SET=${TZ_SET:-$(conf_get TZ)}; TZ_SET=${TZ_SET:-$CUR_TZ}
fi
[[ "$PORT" =~ ^[0-9]+$ ]] || die "Port must be a number"

# ---------------------------------------------------------------- packages
step "Installing system packages (this can take a few minutes on a Pi 3)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl tar coreutils >/dev/null
ok "Base packages ready"

need_node=1
if command -v node >/dev/null; then
  have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$have" -ge 18 ]; then need_node=0; ok "Node.js $(node -v) already installed"; fi
fi
if [ "$need_node" -eq 1 ]; then
  echo "  Installing Node.js $NODE_MAJOR…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node.js $(node -v) installed"
fi
NODE_BIN=$(command -v node)

# ---------------------------------------------------------------- user and files
step "Installing Brewie Web $VERSION"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
systemctl stop brewie-web 2>/dev/null || true
TMP=$(mktemp -d)
extract_payload "$TMP"
rm -rf "$APP_DIR.new"; mv "$TMP/brewie-web" "$APP_DIR.new"; rm -rf "$TMP"
rm -rf "$APP_DIR.old"; [ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"; rm -rf "$APP_DIR.old"
chown -R root:root "$APP_DIR"
mkdir -p "$DATA_DIR"
ok "App in $APP_DIR, data in $DATA_DIR"

if [ -n "$MIGRATE" ]; then
  step "Copying recipes & settings from $MIGRATE (enter that machine's password)"
  if scp -o StrictHostKeyChecking=accept-new -r "$MIGRATE:/mnt/user/appdata/brewie-web/." "$DATA_DIR/" </dev/tty; then
    ok "Copied"
    warn "Stop the Unraid container now if you haven't:  docker rm -f brewie-web"
  else
    warn "Copy failed — carrying on. Recipes will be pulled from the Brewie when it connects."
  fi
fi
chown -R "$SVC_USER":"$SVC_USER" "$DATA_DIR"

if [ "$UPDATING" -eq 0 ]; then
  cat >"$CONF" <<EOF
# Brewie Web settings — edit, then: sudo systemctl restart brewie-web
BREWIE_HOST=$BREWIE_HOST
PORT=$PORT
TZ=$TZ_SET
DATA_DIR=$DATA_DIR
NODE_ENV=production
# Optional password for the web page (remove the # to use):
#AUTH_USER=brewer
#AUTH_PASS=change-me
EOF
  ok "Settings written to $CONF"
else
  conf_set() { if grep -q "^$1=" "$CONF"; then sed -i "s|^$1=.*|$1=$2|" "$CONF"; else echo "$1=$2" >>"$CONF"; fi; }
  if [ -n "$CLI_HOST" ]; then conf_set BREWIE_HOST "$CLI_HOST"; fi
  if [ -n "$CLI_PORT" ]; then conf_set PORT "$CLI_PORT"; fi
  if [ -n "$CLI_TZ" ]; then conf_set TZ "$CLI_TZ"; fi
  ok "Settings kept ($CONF)"
fi

# ---------------------------------------------------------------- service
step "Setting up the background service"
cat >"$UNIT" <<EOF
[Unit]
Description=Brewie Web
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$CONF
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN src/server.js
User=$SVC_USER
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable brewie-web >/dev/null 2>&1
systemctl restart brewie-web
ok "Service enabled — starts automatically at boot"

# ---------------------------------------------------------------- wifi
if [ "$NO_WIFI_FIX" -eq 0 ] && command -v nmcli >/dev/null; then
  WIFI=$(nmcli -t -f NAME,TYPE connection show --active 2>/dev/null | awk -F: '$2 ~ /wireless/ {print $1; exit}')
  if [ -n "$WIFI" ]; then
    nmcli connection modify "$WIFI" 802-11-wireless.powersave 2 && ok "Wi-Fi power saving turned off for \"$WIFI\" (fewer dropouts; applies after reboot)"
  fi
fi

# ---------------------------------------------------------------- check
step "Checking it started"
up=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ "$up" -eq 1 ]; then
  ok "$(journalctl -u brewie-web -n 50 --no-pager -o cat | grep -m1 'Brewie Web.*listening' || echo "Brewie Web $VERSION running")"
else
  journalctl -u brewie-web -n 20 --no-pager -o cat || true
  die "Brewie Web didn't start — see the log above."
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "${c_ok}${c_b}Brewie Web $VERSION is running.${c_0}"
echo "  Open on the iPad:  ${c_b}http://${IP:-<pi-ip>}:$PORT${c_0}   (or http://$(hostname).local:$PORT)"
echo "  Brewie address:    $BREWIE_HOST   (change in $CONF, then: sudo systemctl restart brewie-web)"
echo "  Live log:          journalctl -u brewie-web -f"
echo "  Update later:      copy the new installer over and run it the same way."
echo
echo "  Reminder: the Brewie accepts ONE controller — make sure the Unraid container is stopped."
exit 0

__PAYLOAD_BELOW__
