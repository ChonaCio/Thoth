#!/usr/bin/env bash
# Removes the Thoth systemd service.
#
#   sudo bash deploy/uninstall.sh            stop the service and remove it from startup (keeps files)
#   sudo bash deploy/uninstall.sh --purge    also delete the app folder, settings and service user
#
# Options: [--dir /opt/thoth] [--user thoth]
set -euo pipefail

SERVICE=thoth
INSTALL_DIR=/opt/thoth
SERVICE_USER=thoth
PURGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --dir)   INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --user)  SERVICE_USER="${2:?--user needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

echo "==> Stopping and disabling $SERVICE"
systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl reset-failed "$SERVICE" 2>/dev/null || true

if [[ $PURGE -eq 1 ]]; then
  case "$INSTALL_DIR" in
    /|/usr|/usr/*|/etc|/etc/*|/home|/root|/var|/bin|/sbin|/lib*|/boot*) echo "Refusing to delete $INSTALL_DIR" >&2; exit 1 ;;
  esac
  [[ -f "$INSTALL_DIR/server.js" ]] || { echo "$INSTALL_DIR doesn't look like a Thoth install; not deleting it." >&2; exit 1; }
  echo "==> Deleting $INSTALL_DIR and /etc/thoth"
  rm -rf -- "$INSTALL_DIR" /etc/thoth
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    echo "==> Removing user $SERVICE_USER"
    userdel "$SERVICE_USER" 2>/dev/null || true
  fi
else
  echo "Kept $INSTALL_DIR and /etc/thoth. Use --purge to delete them."
fi
echo "==> Done"
