# Minewhile v0.2.0 — Multi-user browser YesPower miner

Minewhile is an **explicit opt-in** browser miner for YesPower 1.0 (`N=2048`, `r=32`). The browser hashes in Web Workers using WebAssembly and talks to a small Node/TypeScript relay over WebSocket. The relay owns the upstream Stratum connection to Zpool.

The original v0.1 path has produced real browser-generated shares accepted by Zpool. v0.2 keeps that mining path intact and adds multi-user payout settings, multiple workers, a transparent 10% developer fee, reconnect handling, a bounded log, and an always-on Ubuntu deployment.

## What v0.2 adds

- per-browser payout wallet and payout currency
- supported payout currencies: `BTC`, `LTC`, `DASH`, `DGB`, `FLUX`, `RVN`
- multiple Web Workers with disjoint nonce ranges
- aggregated total hashrate
- 500-line fixed-height scrollable log
- USER/DEV share counters
- transparent 90/10 USER/DEV schedule
- job generation IDs to reject stale mode-switch shares
- upstream Stratum reconnect with exponential backoff
- browser reconnect to the relay after a relay restart
- exact Origin checking, message limits and per-connection rate limits
- relay bound to localhost in production
- systemd + Caddy + HTTPS/WSS production deployment

Mining **never starts just because the page loads**. The user must press **START MINING**.

## Architecture

```text
Browser
  ├─ UI / payout settings
  ├─ N Web Workers
  └─ YesPower WASM
         │
         │ WebSocket /mine
         ▼
Caddy :443
         │
         ▼
Minewhile relay 127.0.0.1:8080
  ├─ USER Stratum identity
  └─ DEV Stratum identity
         │
         ▼
Zpool YesPower Stratum
```

The browser cannot choose an upstream host, port, developer wallet, arbitrary Stratum password, or arbitrary TCP destination.

## Clone

Clone with the Openwall YesPower submodule:

```bash
git clone --recurse-submodules https://github.com/mortsnedlaw/Minewhile.git
cd Minewhile
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

A downloaded GitHub ZIP does not contain the submodule contents. The production installer detects that case and fetches `vendor/yespower` automatically.

## Local development

### Requirements

- Node.js 18+
- npm
- Docker (used by the Emscripten WASM build)
- Git

On Ubuntu 24.04:

```bash
sudo ./scripts/bootstrap-ubuntu.sh
```

### Configure relay

```bash
cp relay/.env.example relay/.env
```

Edit `relay/.env`:

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

`WEB_ORIGIN` is enforced. If you open Vite from another machine, set the exact browser origin, for example:

```env
WEB_ORIGIN=http://192.0.2.10:5173
```

Multiple exact origins can be comma-separated.

If the browser is on another machine and connects directly to the development relay, also set:

```env
RELAY_HOST=0.0.0.0
```

Use that only for development; keep the Origin allow-list correct and do not expose port 8080 unnecessarily. Production always forces the relay back to `127.0.0.1`.

### Install, test and run

```bash
make install
make test
```

Then use two terminals.

Relay:

```bash
cd relay
npm run dev
```

Frontend:

```bash
cd web
npm run dev -- --host 0.0.0.0
```

The web command builds the YesPower WASM module before Vite starts.

## Developer fee

Minewhile displays the fee in the UI. The hosted relay uses a **global** ten-minute schedule:

```text
9 minutes  USER payout
1 minute   Minewhile payout
repeat
```

That is 10% of mining time, equivalent to six minutes per hour. The cycle is based on server time rather than session start time, so reconnecting does not reset the fee clock.

The browser receives a mode and a `generationId` with each job. Shares from an old generation are rejected by the relay instead of accidentally crossing USER/DEV identities.

Because Minewhile is open source and mining is opt-in, a person who self-hosts modified code can of course change the fee. The official hosted configuration is intentionally transparent rather than hidden.

## Worker model

The browser reads `navigator.hardwareConcurrency` and lets the user choose the worker count. It does **not** automatically consume every logical CPU.

The full 32-bit nonce space is divided into non-overlapping contiguous ranges, one range per Web Worker. All workers get one shared random seed for a job, but the seed is mapped inside each worker's own range. Workers therefore do not duplicate each other's search space even for worker counts such as 3, 6 or 10.

The UI sums each worker's reported H/s into one total hashrate.

## Production install — Ubuntu 24.04

Production uses:

- `/opt/minewhile` — deployed application
- `/var/www/minewhile` — static frontend
- `/etc/minewhile/relay.env` — protected relay configuration
- `minewhile-relay.service` — systemd service
- Caddy — HTTPS and `/mine` WebSocket reverse proxy

Your DNS name must point to the server before Caddy can obtain a public certificate.

### 1. Clone

```bash
git clone --recurse-submodules https://github.com/mortsnedlaw/Minewhile.git
cd Minewhile
```

### 2. Install OS dependencies

```bash
sudo ./scripts/bootstrap-ubuntu.sh
```

### 3. Deploy

First install:

```bash
sudo MINEWHILE_DOMAIN=mine.example.com \
  DEV_WALLET=YOUR_OPERATOR_WALLET \
  DEV_CURRENCY=LTC \
  ./scripts/install-production.sh
```

The installer:

1. initializes/fetches the YesPower source if required
2. copies a clean app tree to `/opt/minewhile`
3. runs `npm ci`
4. runs relay tests
5. builds the relay
6. builds YesPower WASM + the Vite frontend
7. publishes the frontend to `/var/www/minewhile`
8. creates a non-login `minewhile` service account
9. installs and enables the systemd relay service
10. creates an isolated Caddy site snippet without replacing unrelated Caddy sites
11. binds the Node relay only to `127.0.0.1:8080`

After this, closing PuTTY/SSH has no effect on the service.

### Update an existing production install

```bash
git pull --recurse-submodules
git submodule update --init --recursive
sudo MINEWHILE_DOMAIN=mine.example.com ./scripts/install-production.sh
```

The existing `/etc/minewhile/relay.env` is preserved. Passing `DEV_WALLET` or `DEV_CURRENCY` again explicitly updates those values.

### Service operations

```bash
systemctl status minewhile-relay
systemctl restart minewhile-relay
journalctl -u minewhile-relay -f
```

Caddy:

```bash
systemctl status caddy
caddy validate --config /etc/caddy/Caddyfile
journalctl -u caddy -f
```

Public ports should only need HTTP/HTTPS (`80/443`) plus SSH as appropriate. The relay listens on localhost and Vite is not used in production.

## Security boundaries

The relay currently provides the following guardrails:

- exact Origin allow-list from `WEB_ORIGIN`
- maximum WebSocket payload of 16 KiB
- maximum 8 concurrent browser connections per source IP
- general, START and share-submit rate limits
- payout currency whitelist
- payout address length/control-character validation
- server-side DEV wallet
- fixed upstream pool host and port
- active job + mode + generation validation before a share reaches Stratum
- exact `ntime` and `extranonce2` match against the active job
- relay bound to `127.0.0.1` in production

Minewhile intentionally does **not** attempt complete cryptographic validation of every supported coin address. Zpool remains authoritative for whether a payout address/currency pair is useful.

## Build and test

```bash
make test
make build
```

Or directly:

```bash
cd relay
npm ci
npm test
npm run build

cd ../web
npm ci
npm run build
```

`web/npm run build` invokes `wasm/build.sh`, which uses the Emscripten Docker image.

A regression test contains a captured real Zpool v0.1 `mining.notify` fixture and asserts that Minewhile still produces the exact known 76-byte header prefix. The v0.1 nonce byte order and YesPower target path are deliberately documented in code and should not be casually "cleaned up".

## Debugging

For normal operation keep:

```env
DEBUG_STRATUM=0
```

Enable `DEBUG_STRATUM=1` only when debugging Stratum. Raw protocol lines and full header prefixes are intentionally suppressed from the normal browser log.

## Rollback

The production installer deploys whatever checkout you give it. To roll back:

```bash
git checkout <known-good-tag-or-commit>
git submodule update --init --recursive
sudo MINEWHILE_DOMAIN=mine.example.com ./scripts/install-production.sh
```

## Known limitations / next steps

- YesPower currently uses the reference implementation compiled to WASM; optimization is a separate performance step.
- No CPU auto-tuning yet; worker count is user-selected.
- No database or account system.
- No own pool, coin, Swish payout, ads, referral system, or multi-algorithm switching.
- No full per-currency blockchain address validation.

The next performance-oriented milestone should benchmark an optimized YesPower WASM build and add optional worker auto-tuning **without changing the already-proven header/nonce/target behavior**.
