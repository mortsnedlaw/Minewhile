#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_PATH="/etc/systemd/system/minewhile-relay.service"
CADDY_PATH="/etc/caddy/Caddyfile"

if [[ "$EUID" -ne 0 ]]; then
  echo "This script should be run as root or with sudo."
  exit 1
fi

cd "$ROOT/relay"
npm install
npm run build

cd "$ROOT/web"
npm install
npm run build

cat > "$SERVICE_PATH" <<'EOF'
[Unit]
Description=Minewhile Stratum Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/Minewhile/relay
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable minewhile-relay
systemctl restart minewhile-relay

if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y caddy
fi

if [[ ! -f "$CADDY_PATH" ]]; then
  install -d /etc/caddy
  cp "$ROOT/deploy/Caddyfile.example" "$CADDY_PATH"
  systemctl reload caddy || true
fi

echo "Installed Minewhile production relay and Caddy example config."
echo "Review /etc/systemd/system/minewhile-relay.service and /etc/caddy/Caddyfile before production use."
