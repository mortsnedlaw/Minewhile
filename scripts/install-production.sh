#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/minewhile"
WEB_DIR="/var/www/minewhile"
ENV_DIR="/etc/minewhile"
ENV_FILE="$ENV_DIR/relay.env"
SERVICE_PATH="/etc/systemd/system/minewhile-relay.service"
CADDY_DIR="/etc/caddy/Caddyfile.d"
CADDY_SITE="$CADDY_DIR/minewhile.caddy"
CADDY_MAIN="/etc/caddy/Caddyfile"
DOMAIN="${MINEWHILE_DOMAIN:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo, for example:"
  echo "  sudo MINEWHILE_DOMAIN=mine.example.com DEV_WALLET=... ./scripts/install-production.sh"
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "MINEWHILE_DOMAIN is required (DNS must point to this server)."
  exit 1
fi

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "MINEWHILE_DOMAIN contains invalid characters."
  exit 1
fi

if [[ ! -f "$ENV_FILE" && -z "${DEV_WALLET:-}" ]]; then
  echo "DEV_WALLET is required on the first install."
  echo "Example: sudo MINEWHILE_DOMAIN=$DOMAIN DEV_WALLET=YOUR_LTC_ADDRESS ./scripts/install-production.sh"
  exit 1
fi

for command in git rsync node npm docker caddy systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command"
    echo "Run: sudo ./scripts/bootstrap-ubuntu.sh"
    exit 1
  fi
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 18 )); then
  echo "Node.js 18+ is required; found $(node --version)."
  exit 1
fi

systemctl enable --now docker >/dev/null
systemctl enable --now caddy >/dev/null

"$ROOT/scripts/ensure-yespower.sh"

if ! id -u minewhile >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin minewhile
fi

install -d -m 0755 "$APP_DIR" "$WEB_DIR" "$ENV_DIR" "$CADDY_DIR"

# Deploy a clean application copy. Secrets, git metadata and build products are
# deliberately excluded; builds are recreated below.
if [[ "$(realpath "$ROOT")" != "$(realpath "$APP_DIR")" ]]; then
  rsync -a --delete \
    --exclude='.git/' \
    --exclude='node_modules/' \
    --exclude='dist/' \
    --exclude='.env' \
    --exclude='web/src/generated/' \
    "$ROOT/" "$APP_DIR/"
fi

cd "$APP_DIR/relay"
npm ci
npm test
npm run build

cd "$APP_DIR/web"
npm ci
npm run build

rsync -a --delete "$APP_DIR/web/dist/" "$WEB_DIR/"
chown -R minewhile:minewhile "$APP_DIR"
chown -R root:root "$WEB_DIR"
chmod -R a+rX "$WEB_DIR"

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<ENVEOF
POOL_HOST=${POOL_HOST:-yespower.eu.mine.zpool.ca}
POOL_PORT=${POOL_PORT:-6234}
RELAY_HOST=127.0.0.1
RELAY_PORT=8080
WEB_ORIGIN=https://${DOMAIN}
DEV_WALLET=${DEV_WALLET}
DEV_CURRENCY=${DEV_CURRENCY:-LTC}
DEBUG_STRATUM=${DEBUG_STRATUM:-0}
ENVEOF
else
  update_env "RELAY_HOST" "127.0.0.1"
  update_env "RELAY_PORT" "8080"
  update_env "WEB_ORIGIN" "https://${DOMAIN}"
  [[ -n "${DEV_WALLET:-}" ]] && update_env "DEV_WALLET" "$DEV_WALLET"
  [[ -n "${DEV_CURRENCY:-}" ]] && update_env "DEV_CURRENCY" "$DEV_CURRENCY"
fi

chown root:minewhile "$ENV_FILE"
chmod 0640 "$ENV_FILE"

NODE_BIN="$(command -v node)"
cat > "$SERVICE_PATH" <<SERVICEEOF
[Unit]
Description=Minewhile Stratum Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minewhile
Group=minewhile
WorkingDirectory=$APP_DIR/relay
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/relay/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
SERVICEEOF

cat > "$CADDY_SITE" <<CADDYEOF
$DOMAIN {
    encode zstd gzip

    handle /mine {
        reverse_proxy 127.0.0.1:8080
    }

    handle {
        root * $WEB_DIR
        try_files {path} /index.html
        file_server
    }
}
CADDYEOF

if [[ ! -f "$CADDY_MAIN" ]]; then
  cat > "$CADDY_MAIN" <<'CADDYMAIN'
import Caddyfile.d/*.caddy
CADDYMAIN
elif ! grep -Eq '^[[:space:]]*import[[:space:]]+Caddyfile\.d/\*\.caddy[[:space:]]*$' "$CADDY_MAIN"; then
  cat >> "$CADDY_MAIN" <<'CADDYIMPORT'

# Minewhile installer: load independently managed site snippets.
import Caddyfile.d/*.caddy
CADDYIMPORT
fi

caddy fmt --overwrite "$CADDY_SITE" >/dev/null
caddy validate --config "$CADDY_MAIN"

systemctl daemon-reload
systemctl enable minewhile-relay >/dev/null
systemctl restart minewhile-relay
systemctl reload caddy

if ! systemctl is-active --quiet minewhile-relay; then
  echo "Minewhile relay failed to start. Recent logs:"
  journalctl -u minewhile-relay -n 60 --no-pager
  exit 1
fi

echo
echo "Minewhile v0.2.0 deployed."
echo "Site:    https://$DOMAIN"
echo "Relay:   127.0.0.1:8080 (not publicly exposed)"
echo "Service: systemctl status minewhile-relay"
echo "Logs:    journalctl -u minewhile-relay -f"
echo
echo "Caddy will obtain HTTPS automatically once DNS for $DOMAIN points to this server."
