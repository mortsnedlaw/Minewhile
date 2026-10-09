# Minewhile v0.2.0 — Multi-user browser YesPower miner

Minewhile is a browser-based YesPower miner that keeps the known-working v0.1 mining path intact while adding a usable service model:

- per-user payout wallet + currency selection
- 90/10 user/dev mining schedule
- multiple browser workers with non-overlapping nonce ranges
- fixed-height scrollable log view
- server-side relay to control upstream Stratum config
- production deployment with systemd + Caddy

## Project layout

- relay/: Node.js + TypeScript Stratum relay and session manager
- web/: Vite + TypeScript browser app and worker pool
- wasm/: Openwall YesPower -> Emscripten WASM build script
- vendor/yespower/: upstream YesPower implementation

## Local development

### 1. Install dependencies

```bash
cd relay && npm install
cd ../web && npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then set:

```env
POOL_HOST=yespower.eu.mine.zpool.ca
POOL_PORT=6234
RELAY_HOST=127.0.0.1
RELAY_PORT=8080
WEB_ORIGIN=http://localhost:5173
DEV_WALLET=YOUR_OPERATOR_WALLET
DEV_CURRENCY=LTC
DEBUG_STRATUM=0
```

### 3. Build WASM

```bash
./wasm/build.sh
```

### 4. Run relay and frontend

Terminal 1:

```bash
cd relay
npm run dev
```

Terminal 2:

```bash
cd web
npm run dev -- --host 0.0.0.0
```

Open the frontend in a browser, choose a supported payout currency and wallet, then press Start.

## Production deployment

### Ubuntu 24.04

Install dependencies:

```bash
sudo apt update
sudo apt install -y curl git build-essential nodejs npm caddy
```

Then run the production installer:

```bash
chmod +x scripts/install-production.sh
sudo ./scripts/install-production.sh
```

The installer builds the relay and web frontend, installs the systemd service, enables it, and restarts the relay.

### Service management

```bash
systemctl status minewhile-relay
systemctl restart minewhile-relay
journalctl -u minewhile-relay -f
```

## Supported payout currencies

BTC, LTC, DASH, DGB, FLUX, RVN

Additional currencies can be added by extending the whitelist in the relay session validation and the frontend currency list.

## Developer fee schedule

The service uses a 90/10 schedule based on elapsed session time, not wall-clock UTC time:

- user mode: 9 minutes
- developer mode: 1 minute
- repeat the cycle

This is the preferred schedule because it spreads the fee evenly across each hour.

## Security and relay boundaries

The browser is never allowed to send:

- upstream pool hostname or port
- DEV wallet
- arbitrary Stratum parameters
- raw shell commands

All browser-controlled values are sanitized and validated on the relay side before they are used to authorize with the upstream pool.

## Build and test

```bash
cd relay && npm run build && npm test
cd ../web && npm run build
```

## Migration from v0.1

1. Keep the existing YesPower WASM and Stratum flow intact.
2. Update the relay to use per-session user/dev upstream identities.
3. Update the browser to send a validated start payload.
4. Restart the relay under systemd for production use.

## Rollback

If a deployment needs to revert to the previous state:

```bash
sudo systemctl stop minewhile-relay
git checkout <previous-tag-or-commit>
cd relay && npm install && npm run build
cd ../web && npm install && npm run build
sudo systemctl start minewhile-relay
```

## Known limitations

- No cryptographic address validation for every supported blockchain in this version.
- No database or account system.
- No automatic benchmark/autotuning.
- The v0.2 release is focused on the working browser miner and production deployment path.
