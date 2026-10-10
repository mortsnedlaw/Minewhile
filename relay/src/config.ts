import "dotenv/config";

export const SUPPORTED_PAYOUT_CURRENCIES = ["BTC", "LTC", "BCH", "DASH", "ADVC", "ARRR", "BC2", "BCH2", "BELLS", "BTCZ", "BTGS", "CAP", "CAT", "CHI", "CY", "DGB", "DOGE", "DOGM", "EAC", "EQPAY", "EVR", "FJAR", "FLUX", "GBX", "GRR", "GRS", "HOOT", "KCCC", "KMD", "KRGN", "KV5", "LC2", "LCN", "LPEPE", "MAXI", "MCL", "MEC", "MECU", "MEWC", "MONA", "MYT", "NENG", "OBTC", "PAC", "PEPEW", "PLSR", "PPC", "RIN", "RTM", "RVN", "RXD", "SCC", "SKYDOGE", "SOH", "SWAMP", "TLS", "URSA", "VTC", "WDC", "WJK", "XDN", "YEC", "ZCL", "ZER"] as const;
export type SupportedCurrency = (typeof SUPPORTED_PAYOUT_CURRENCIES)[number];

function parseOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

const devCurrencyRaw = (process.env.DEV_CURRENCY ?? "LTC").trim().toUpperCase();

export const config = {
  poolHost: (process.env.POOL_HOST ?? "yespower.eu.mine.zpool.ca").trim(),
  poolPort: parsePort(process.env.POOL_PORT ?? "6234", "POOL_PORT"),
  relayHost: (process.env.RELAY_HOST ?? "127.0.0.1").trim(),
  relayPort: parsePort(process.env.RELAY_PORT ?? "8080", "RELAY_PORT"),
  webOrigins: parseOrigins(process.env.WEB_ORIGIN ?? "http://localhost:5173"),
  debug: process.env.DEBUG_STRATUM === "1",
  devWallet: (process.env.DEV_WALLET ?? "").trim(),
  devCurrency: devCurrencyRaw as SupportedCurrency
};

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return (SUPPORTED_PAYOUT_CURRENCIES as readonly string[]).includes(value);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return config.webOrigins.includes(origin);
}

export function assertRuntimeConfig() {
  if (!config.poolHost) throw new Error("Missing required env POOL_HOST");
  if (!config.devWallet || config.devWallet === "REPLACE_ME") {
    throw new Error("Missing required env DEV_WALLET");
  }
  if (!isSupportedCurrency(config.devCurrency)) {
    throw new Error(`Unsupported DEV_CURRENCY: ${config.devCurrency}`);
  }
  if (config.webOrigins.length === 0) {
    throw new Error("WEB_ORIGIN must contain at least one allowed browser origin");
  }
}
