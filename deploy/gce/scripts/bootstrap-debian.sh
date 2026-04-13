#!/usr/bin/env bash
# Run on a fresh Debian/Ubuntu VM as root: sudo bash bootstrap-debian.sh
set -euo pipefail

APP_USER="thedirection"
APP_DIR="/opt/the_direction"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git

# Node.js 20.x (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

if ! id -u "${APP_USER}" &>/dev/null; then
  useradd --system --home-dir "${APP_DIR}" --create-home --shell /bin/bash "${APP_USER}"
fi

mkdir -p "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

echo "Done. Next (as ${APP_USER}): clone repo into ${APP_DIR}, copy deploy/gce/env.example to .env, npm ci --omit=dev, install systemd unit."
