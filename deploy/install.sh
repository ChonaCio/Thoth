#!/usr/bin/env bash
# Installs Thoth as a systemd service that starts on boot.
#
#   sudo bash deploy/install.sh [--dir /opt/thoth] [--user thoth] [--port 3000] [--host 0.0.0.0] [--no-start]
#
# Safe to run again: it updates the app files and the unit, and keeps /etc/thoth/thoth.env,
# the installed-version record and update backups.
set -euo pipefail

SERVICE=thoth
INSTALL_DIR=/opt/thoth
SERVICE_USER=thoth
PORT=""
HOST=""
START=1
ENV_DIR=/etc/thoth
ENV_FILE="$ENV_DIR/thoth.env"
UNIT_FILE="/etc/systemd/system/$SERVICE.service"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)      INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --user)     SERVICE_USER="${2:?--user needs a value}"; shift 2 ;;
    --port)     PORT="${2:?--port needs a value}"; shift 2 ;;
    --host)     HOST="${2:?--host needs a value}"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help)  usage 0 ;;
    *)          warn "Unknown option: $1"; usage 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run as root: sudo bash $0"
command -v systemctl >/dev/null || fail "systemd (systemctl) not found. This script needs a systemd-based Linux."
[[ "$INSTALL_DIR" = /* ]] || fail "--dir must be an absolute path"
[[ -z "$PORT" || ( "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ) ]] || fail "--port must be a number from 1 to 65535"
[[ -z "$HOST" || "$HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || fail "--host must be an IP address or host name"
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "--user is not a valid user name"

# ---- Node.js ----
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || fail "Node.js not found. Install Node.js 18 or newer (e.g. https://nodejs.org or your distro's nodejs package)."
NODE_BIN="$(readlink -f "$NODE_BIN")"
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || fail "Node.js 18 or newer is required (found $("$NODE_BIN" --version))."

PROTECT_HOME=true
case "$NODE_BIN" in
  /root/*)
    fail "Node.js is installed under /root ($NODE_BIN), which the service user can't read. Install Node.js system-wide (e.g. your distro's package or NodeSource)." ;;
  /home/*)
    warn "Node.js is installed under /home ($NODE_BIN), e.g. via nvm. The service will get read-only access to /home. A system-wide Node.js is recommended."
    PROTECT_HOME=read-only ;;
esac

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SRC_DIR/server.js" ]] || fail "Can't find server.js in $SRC_DIR"

# ---- Service user ----
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "Using existing user '$SERVICE_USER'"
else
  info "Creating system user '$SERVICE_USER'"
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --user-group --home-dir "$INSTALL_DIR" --no-create-home --shell "$NOLOGIN" "$SERVICE_USER"
fi

# ---- App files ----
mkdir -p "$INSTALL_DIR"
if [[ "$(readlink -f "$SRC_DIR")" != "$(readlink -f "$INSTALL_DIR")" ]]; then
  info "Copying app to $INSTALL_DIR"
  tar -C "$SRC_DIR" \
      --exclude=./.git --exclude=./.updates --exclude=./.update-state.json --exclude=./data \
      --exclude=./node_modules --exclude=./.env --exclude=./.build-info.json \
      -cf - . | tar -C "$INSTALL_DIR" -xf -
  # Record which commit was installed (the copy has no .git), so the app can show its version
  "$NODE_BIN" "$SRC_DIR/scripts/stamp-build.js" --out "$INSTALL_DIR/.build-info.json" || warn "Couldn't record the installed version"
else
  info "Installing in place ($INSTALL_DIR)"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"

# ---- Settings ----
set_env() {  # set_env KEY VALUE: replace or append KEY=VALUE in the env file
  if grep -qE "^#? *$1=" "$ENV_FILE"; then
    sed -i -E "s|^#? *$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
mkdir -p "$ENV_DIR"
if [[ -f "$ENV_FILE" ]]; then
  info "Keeping existing settings in $ENV_FILE"
else
  info "Creating settings file $ENV_FILE"
  cp "$SRC_DIR/deploy/thoth.env.example" "$ENV_FILE"
fi
[[ -n "$PORT" ]] && set_env PORT "$PORT"
[[ -n "$HOST" ]] && set_env HOST "$HOST"
sed -i 's/\r$//' "$ENV_FILE"   # tolerate files edited on Windows
chown "root:$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"   # may contain GITHUB_TOKEN

# ---- systemd unit ----
info "Writing $UNIT_FILE"
sed -e "s|@USER@|$SERVICE_USER|g" \
    -e "s|@DIR@|$INSTALL_DIR|g" \
    -e "s|@NODE@|$NODE_BIN|g" \
    -e "s|@PROTECT_HOME@|$PROTECT_HOME|g" \
    -e 's/\r$//' \
    "$SRC_DIR/deploy/thoth.service" > "$UNIT_FILE"
chmod 644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
info "Enabled: $SERVICE starts automatically on boot"

if [[ $START -eq 0 ]]; then
  info "Not starting now (--no-start). Start with: sudo systemctl start $SERVICE"
  exit 0
fi

info "Starting $SERVICE"
systemctl restart "$SERVICE"

# ---- Health check ----
CFG_PORT="$( (grep -E '^PORT=' "$ENV_FILE" || true) | tail -n1 | cut -d= -f2 | tr -d '[:space:]"')"
CFG_HOST="$( (grep -E '^HOST=' "$ENV_FILE" || true) | tail -n1 | cut -d= -f2 | tr -d '[:space:]"')"
CFG_PORT="${CFG_PORT:-3000}"
CHECK_HOST="${CFG_HOST:-127.0.0.1}"
[[ "$CHECK_HOST" == "0.0.0.0" || "$CHECK_HOST" == "::" ]] && CHECK_HOST=127.0.0.1
[[ "$CHECK_HOST" == *:* ]] && CHECK_HOST="[$CHECK_HOST]"
URL="http://$CHECK_HOST:$CFG_PORT"

for _ in $(seq 1 15); do
  if "$NODE_BIN" -e "fetch('$URL/api/session').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    info "Thoth is running"
    if [[ -z "$CFG_HOST" || "$CFG_HOST" == "0.0.0.0" || "$CFG_HOST" == "::" ]]; then
      echo "  Open it from any device on the network:"
      for ip in $(hostname -I 2>/dev/null || true); do
        [[ "$ip" == *:* ]] && continue   # skip IPv6 for brevity
        echo "    http://$ip:$CFG_PORT"
      done
      command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active" && \
        warn "ufw firewall is active. Allow the port with: sudo ufw allow $CFG_PORT/tcp"
      command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1 && \
        warn "firewalld is active. Allow the port with: sudo firewall-cmd --permanent --add-port=$CFG_PORT/tcp && sudo firewall-cmd --reload"
    else
      echo "  Listening on $URL"
      [[ "$CFG_HOST" == "127.0.0.1" ]] && echo "  Only reachable from this machine. Set HOST=0.0.0.0 in $ENV_FILE for network access."
    fi
    if [[ ! -s "$INSTALL_DIR/data/users.json" ]]; then
      echo
      echo "  Next: open the app and create the first user. It becomes the administrator."
      echo "  Do this right away: until then, anyone who can reach the server can claim it."
    fi
    echo
    echo "  Status:   systemctl status $SERVICE"
    echo "  Logs:     journalctl -u $SERVICE -f"
    echo "  Restart:  sudo systemctl restart $SERVICE"
    echo "  Settings: $ENV_FILE"
    exit 0
  fi
  sleep 1
done

warn "The service didn't respond at $URL. Recent logs:"
journalctl -u "$SERVICE" -n 30 --no-pager || true
exit 1
