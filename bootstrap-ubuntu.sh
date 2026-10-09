#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/bootstrap-ubuntu.sh"
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git build-essential rsync \
  docker.io nodejs npm caddy

systemctl enable --now docker
systemctl enable --now caddy

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 18 )); then
  echo "Node.js 18+ is required; installed version is $(node --version)."
  echo "Install a newer Node.js release before continuing."
  exit 1
fi

echo "Ubuntu dependencies ready."
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "Docker: $(docker --version)"
echo "Caddy: $(caddy version)"
