import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

export const config = {
  poolHost: required("POOL_HOST"),
  poolPort: Number(required("POOL_PORT")),
  wallet: required("POOL_WALLET"),
  password: process.env.POOL_PASSWORD ?? "c=LTC",
  relayPort: Number(process.env.RELAY_PORT ?? "8080"),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  debug: process.env.DEBUG_STRATUM === "1"
};
