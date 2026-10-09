import "dotenv/config";

export const SUPPORTED_PAYOUT_CURRENCIES = ["BTC", "LTC", "DASH", "DGB", "FLUX", "RVN"] as const;
export type SupportedCurrency = (typeof SUPPORTED_PAYOUT_CURRENCIES)[number];

export const config = {
  poolHost: process.env.POOL_HOST ?? "yespower.eu.mine.zpool.ca",
  poolPort: Number(process.env.POOL_PORT ?? "6234"),
  relayHost: process.env.RELAY_HOST ?? "127.0.0.1",
  relayPort: Number(process.env.RELAY_PORT ?? "8080"),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  debug: process.env.DEBUG_STRATUM === "1",
  devWallet: process.env.DEV_WALLET ?? "",
  devCurrency: (process.env.DEV_CURRENCY ?? "LTC").trim().toUpperCase() as SupportedCurrency,
  password: process.env.POOL_PASSWORD ?? "c=LTC"
};

export function assertRuntimeConfig() {
  if (!config.poolHost) throw new Error("Missing required env POOL_HOST");
  if (!config.poolPort) throw new Error("Missing required env POOL_PORT");
  if (!config.devWallet) throw new Error("Missing required env DEV_WALLET");
}
