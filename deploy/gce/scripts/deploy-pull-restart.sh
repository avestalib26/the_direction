#!/usr/bin/env bash
# Run on the VM as root after git remote is configured for /opt/the_direction
set -euo pipefail

APP_USER="thedirection"
APP_DIR="/opt/the_direction"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)."
  exit 1
fi

sudo -u "${APP_USER}" -H bash -c "
  set -e
  cd '${APP_DIR}'
  git pull
  npm ci --omit=dev
"

systemctl restart the-direction-api
systemctl --no-pager status the-direction-api
