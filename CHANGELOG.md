# Changelog

## v0.2.0 — Multi-user

- Added per-session payout currency and wallet selection.
- Added transparent global 90/10 USER/DEV mining schedule.
- Added separate USER/DEV upstream Stratum identities and share counters.
- Added job generation IDs to prevent stale shares crossing mode switches.
- Added multiple Web Workers with truly disjoint uint32 nonce ranges.
- Added aggregate hashrate, active-worker count, difficulty and session timing.
- Added bounded 500-line scrollable log with clear and auto-scroll controls.
- Added browser reconnect and upstream Stratum exponential reconnect.
- Added Origin enforcement, payload limits, connection limits and rate limiting.
- Added strict submit validation for active job, mode, generation, ntime and extranonce2.
- Added captured Zpool header76 regression fixture from the working v0.1 path.
- Added Ubuntu production installer using systemd, Caddy and HTTPS/WSS.
- Relay production process now runs compiled `dist/index.js` as an unprivileged service user.
- Added clone/ZIP-safe YesPower source bootstrap and GitHub Actions CI.
