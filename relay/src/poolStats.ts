const API_BASE = "https://www.zpool.ca/api";
const FETCH_TIMEOUT_MS = 8_000;
const PUBLIC_CACHE_MS = 30_000;

type JsonObject = Record<string, any>;
let publicCache: { expiresAt: number; currencies: JsonObject; blocks: any[] } | null = null;

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(path: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: { "user-agent": "Minewhile/0.3" }
    });
    if (!response.ok) throw new Error(`stats HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getPublicPoolData() {
  const now = Date.now();
  if (publicCache && publicCache.expiresAt > now) return publicCache;
  const [currenciesRaw, blocksRaw] = await Promise.all([
    fetchJson("/currencies"),
    fetchJson("/blocks")
  ]);
  const currencies = currenciesRaw && typeof currenciesRaw === "object" && !Array.isArray(currenciesRaw) ? currenciesRaw : {};
  const blocks = Array.isArray(blocksRaw) ? blocksRaw : blocksRaw && typeof blocksRaw === "object" ? Object.values(blocksRaw) : [];
  publicCache = { expiresAt: now + PUBLIC_CACHE_MS, currencies, blocks };
  return publicCache;
}

export async function getWalletStats(address: string) {
  const [walletRaw, publicData] = await Promise.all([
    fetchJson(`/walletEX?address=${encodeURIComponent(address)}`),
    getPublicPoolData()
  ]);
  const wallet = walletRaw && typeof walletRaw === "object" ? walletRaw : {};
  const yespowerCoins = new Set(
    Object.entries(publicData.currencies)
      .filter(([, value]) => String((value as any)?.algo ?? "").toLowerCase() === "yespower")
      .map(([symbol]) => symbol.toUpperCase())
  );
  const recentBlocks = publicData.blocks
    .filter((block: any) => {
      const coin = String(block?.coin ?? "").toUpperCase();
      return yespowerCoins.has(coin) || yespowerCoins.has(coin.split("-")[0]);
    })
    .sort((a: any, b: any) => asNumber(b?.time) - asNumber(a?.time))
    .slice(0, 5)
    .map((block: any) => ({
      coin: String(block?.coin ?? ""),
      time: asNumber(block?.time),
      height: String(block?.height ?? ""),
      amount: asNumber(block?.amount),
      category: String(block?.category ?? "")
    }));
  const payouts = Array.isArray(wallet.payouts)
    ? wallet.payouts.slice(0, 5).map((x: any) => ({ time: asNumber(x?.time), amount: asNumber(x?.amount), tx: String(x?.tx ?? "") }))
    : [];
  return {
    unsold: asNumber(wallet.unsold),
    balance: asNumber(wallet.balance),
    unpaid: asNumber(wallet.unpaid),
    paid24h: asNumber(wallet.paid24h),
    total: asNumber(wallet.total),
    payouts,
    recentBlocks
  };
}
