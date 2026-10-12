import { config } from "./config.js";
import {
  ALGORITHM_IDS,
  YESPOWER_ALGORITHMS,
  type AlgorithmId
} from "./algorithms.js";

const API_BASE = "https://www.zpool.ca/api";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_MS = 60_000;
const DIFF1_HASHES = 4_294_967_296;

export const schedulerMode = (process.env.ALGO_MODE ?? "auto").trim().toLowerCase();

type JsonObject = Record<string, any>;

let cache: {
  expiresAt: number;
  status: JsonObject;
  currencies: JsonObject;
} | null = null;

type ChainObservation = {
  height: number;
  at: number;
  blockSeconds: number | null;
  samples: number;
};

const chainObservations = new Map<string, ChainObservation>();

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function median(values: number[]): number {
  const clean = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function updateChainObservations(currencies: JsonObject, now: number) {
  for (const [symbol, raw] of Object.entries(currencies)) {
    const height = Math.floor(asNumber(raw?.height));
    if (height <= 0) continue;

    const previous = chainObservations.get(symbol);

    if (!previous || height < previous.height) {
      chainObservations.set(symbol, {
        height,
        at: now,
        blockSeconds: previous?.blockSeconds ?? null,
        samples: previous?.samples ?? 0
      });
      continue;
    }

    if (height === previous.height) continue;

    const blocks = height - previous.height;
    const elapsedSeconds = Math.max(1, (now - previous.at) / 1000);
    const sample = elapsedSeconds / blocks;

    let blockSeconds = previous.blockSeconds;

    if (sample >= 1 && sample <= 86_400) {
      blockSeconds =
        blockSeconds == null
          ? sample
          : blockSeconds * 0.70 + sample * 0.30;
    }

    chainObservations.set(symbol, {
      height,
      at: now,
      blockSeconds,
      samples: previous.samples + 1
    });
  }
}

async function fetchJson(path: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: { "user-agent": "Minewhile/1.0" }
    });

    if (!response.ok) {
      throw new Error(`Pool API ${path} returned HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getPoolSnapshot() {
  const now = Date.now();

  if (cache && cache.expiresAt > now) return cache;

  const [statusRaw, currenciesRaw] = await Promise.all([
    fetchJson("/status"),
    fetchJson("/currencies")
  ]);

  const status =
    statusRaw && typeof statusRaw === "object" && !Array.isArray(statusRaw)
      ? statusRaw
      : {};

  const currencies =
    currenciesRaw && typeof currenciesRaw === "object" && !Array.isArray(currenciesRaw)
      ? currenciesRaw
      : {};

  updateChainObservations(currencies, now);

  cache = {
    expiresAt: now + CACHE_MS,
    status,
    currencies
  };

  return cache;
}

function findStatusEntry(status: JsonObject, poolAlgorithm: string): any | null {
  const wanted = poolAlgorithm.toLowerCase();

  for (const [key, value] of Object.entries(status)) {
    const name = String(value?.name ?? key).toLowerCase();
    if (key.toLowerCase() === wanted || name === wanted) return value;
  }

  return null;
}

function findCurrentCoin(currencies: JsonObject, poolAlgorithm: string) {
  const wanted = poolAlgorithm.toLowerCase();

  const matches = Object.entries(currencies)
    .filter(([, raw]) => String(raw?.algo ?? "").toLowerCase() === wanted)
    .sort((a, b) => {
      const aScore = Math.max(asNumber(a[1]?.estimate), asNumber(a[1]?.estimate_current));
      const bScore = Math.max(asNumber(b[1]?.estimate), asNumber(b[1]?.estimate_current));
      return bScore - aScore;
    });

  if (!matches.length) return null;

  return {
    symbol: matches[0][0],
    raw: matches[0][1]
  };
}

function blendedProfit(entry: any): number {
  const current = asNumber(entry?.estimate_current);
  const last24h = asNumber(entry?.estimate_last24h);

  if (current > 0 && last24h > 0) {
    return current * 0.65 + last24h * 0.35;
  }

  return Math.max(current, last24h);
}

function networkEstimate(
  currencies: JsonObject,
  poolAlgorithm: string,
  poolHashrate: number
) {
  const coin = findCurrentCoin(currencies, poolAlgorithm);

  if (!coin) {
    return {
      currentCoin: null as string | null,
      networkHashrate: poolHashrate,
      blockSeconds: null as number | null,
      samples: 0,
      source: poolHashrate > 0 ? "pool-lower-bound" : "unavailable",
      confidence: "learning"
    };
  }

  const obs = chainObservations.get(coin.symbol);
  const blockSeconds = obs?.blockSeconds ?? null;
  const samples = obs?.samples ?? 0;
  const poolCoinHashrate = asNumber(coin.raw?.hashrate);
  const lowerBound = Math.max(poolHashrate, poolCoinHashrate);

  let chainEstimate = 0;
  let source = "pool-lower-bound";

  if (blockSeconds && blockSeconds > 0) {
    const poolTtf = asNumber(coin.raw?.pool_ttf);

    // Preferred estimate: observed full-chain block cadence combined with
    // the pool's expected block-finding time.
    if (poolHashrate > 0 && poolTtf > 0) {
      chainEstimate = poolHashrate * poolTtf / blockSeconds;
      source = "chain-cadence+pool-ttf";
    } else {
      // Fallback for chains exposing conventional PoW difficulty.
      const difficulty = asNumber(coin.raw?.difficulty);
      if (difficulty > 0) {
        chainEstimate = difficulty * DIFF1_HASHES / blockSeconds;
        source = "chain-difficulty+block-cadence";
      }
    }
  }

  const networkHashrate = Math.max(lowerBound, chainEstimate);

  if (chainEstimate <= 0 && lowerBound <= 0) {
    source = "unavailable";
  } else if (chainEstimate > 0 && networkHashrate > chainEstimate) {
    source = "chain-estimate+pool-lower-bound";
  }

  const confidence =
    samples >= 5 ? "high" :
    samples >= 2 ? "medium" :
    samples >= 1 ? "low" :
    "learning";

  return {
    currentCoin: coin.symbol,
    networkHashrate,
    blockSeconds,
    samples,
    source,
    confidence
  };
}

function saturationPenalty(
  projectedFleetShare: number | null,
  source: string
): number {
  // A pool-only lower bound is not sufficient evidence to punish an algo.
  if (!source.startsWith("chain")) return 1;

  if (projectedFleetShare == null || projectedFleetShare <= 0.10) return 1;
  if (projectedFleetShare <= 0.25) return 0.95;
  if (projectedFleetShare <= 0.50) return 0.85;
  if (projectedFleetShare <= 1.00) return 0.70;
  if (projectedFleetShare <= 2.00) return 0.50;

  return Math.max(0.30, Math.min(0.50, 1 / projectedFleetShare));
}

function hostForAlgorithm(id: AlgorithmId): string {
  const algo = YESPOWER_ALGORITHMS[id];
  const firstDot = config.poolHost.indexOf(".");
  const suffix =
    firstDot >= 0
      ? config.poolHost.slice(firstDot + 1)
      : "eu.mine.zpool.ca";

  return `${algo.poolAlgorithm}.${suffix}`;
}

export type AlgorithmEndpoint = {
  id: AlgorithmId;
  host: string;
  port: number;
};

export async function getAlgorithmEndpoint(id: AlgorithmId): Promise<AlgorithmEndpoint> {
  if (id === "yespower") {
    return {
      id,
      host: config.poolHost,
      port: config.poolPort
    };
  }

  const snapshot = await getPoolSnapshot();
  const entry = findStatusEntry(
    snapshot.status,
    YESPOWER_ALGORITHMS[id].poolAlgorithm
  );

  const port = asNumber(entry?.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`No usable upstream endpoint for ${id}`);
  }

  return {
    id,
    host: hostForAlgorithm(id),
    port
  };
}

export type AlgorithmCandidate = {
  id: AlgorithmId;
  displayName: string;
  poolAlgorithm: string;
  port: number;

  benchmarkHps: number;

  currentCoin: string | null;

  poolHashrate: number;
  networkHashrate: number;
  networkBlockTimeSec: number | null;
  networkSamples: number;
  networkHashrateSource: string;
  networkConfidence: string;

  browserNetworkShare: number | null;
  poolNetworkShare: number | null;

  projectedFleetHashrate: number;
  projectedFleetShare: number | null;

  estimateCurrent: number;
  estimate24h: number;
  profitabilityScore: number;

  impactRatio: number | null;
  impactPenalty: number;
  score: number;
};

export function rankAlgorithmCandidates(
  status: JsonObject,
  currencies: JsonObject,
  benchmarks: Record<string, number>,
  fleetEstimate = 1
): AlgorithmCandidate[] {
  const ranked: AlgorithmCandidate[] = [];

  for (const id of ALGORITHM_IDS) {
    const algo = YESPOWER_ALGORITHMS[id];
    const entry = findStatusEntry(status, algo.poolAlgorithm);

    if (!entry) continue;

    const port = asNumber(entry.port);
    const benchmarkHps = asNumber(benchmarks[id]);

    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      benchmarkHps <= 0
    ) continue;

    const estimateCurrent = asNumber(entry.estimate_current);
    const estimate24h = asNumber(entry.estimate_last24h);
    const factor = Math.max(
      0.000000001,
      asNumber(entry.mbtc_mh_factor) || 1
    );

    const profitabilityScore =
      blendedProfit(entry) * benchmarkHps / factor;

    const poolHashrate = asNumber(entry.hashrate);

    const network = networkEstimate(
      currencies,
      algo.poolAlgorithm,
      poolHashrate
    );

    const projectedFleetHashrate =
      benchmarkHps * Math.max(1, fleetEstimate);

    const browserNetworkShare =
      network.networkHashrate > 0
        ? benchmarkHps / network.networkHashrate
        : null;

    const poolNetworkShare =
      network.networkHashrate > 0
        ? poolHashrate / network.networkHashrate
        : null;

    const projectedFleetShare =
      network.networkHashrate > 0
        ? projectedFleetHashrate / network.networkHashrate
        : null;

    const impactPenalty = saturationPenalty(
      projectedFleetShare,
      network.source
    );

    const score = profitabilityScore * impactPenalty;

    ranked.push({
      id,
      displayName: algo.displayName,
      poolAlgorithm: algo.poolAlgorithm,
      port,

      benchmarkHps,

      currentCoin: network.currentCoin,

      poolHashrate,
      networkHashrate: network.networkHashrate,
      networkBlockTimeSec: network.blockSeconds,
      networkSamples: network.samples,
      networkHashrateSource: network.source,
      networkConfidence: network.confidence,

      browserNetworkShare,
      poolNetworkShare,

      projectedFleetHashrate,
      projectedFleetShare,

      estimateCurrent,
      estimate24h,
      profitabilityScore,

      impactRatio: projectedFleetShare,
      impactPenalty,
      score
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function normalizeBenchmarks(input: unknown): Record<string, number> {
  const benchmarks: Record<string, number> = {};

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return benchmarks;
  }

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!ALGORITHM_IDS.includes(key as AlgorithmId)) continue;

    const value = Number(raw);

    if (
      Number.isFinite(value) &&
      value > 0 &&
      value < 10_000_000_000
    ) {
      benchmarks[key] = value;
    }
  }

  return benchmarks;
}

export async function getAlgorithmRecommendation(
  benchmarkInput: unknown,
  activeFleet = 1
) {
  const benchmarks = normalizeBenchmarks(benchmarkInput);
  const snapshot = await getPoolSnapshot();

  const fleetEstimate = Math.max(
    1,
    Math.floor(Number(activeFleet) || 1)
  );

  const ranked = rankAlgorithmCandidates(
    snapshot.status,
    snapshot.currencies,
    benchmarks,
    fleetEstimate
  );

  return {
    mode: schedulerMode,
    fleetEstimate,
    selected: ranked[0] ?? null,
    ranked: ranked.slice(0, 7)
  };
}

export async function getTunePlan(
  knownInput: unknown
): Promise<AlgorithmEndpoint[]> {
  const known = normalizeBenchmarks(knownInput);
  const snapshot = await getPoolSnapshot();

  const raw: Array<{
    id: AlgorithmId;
    score: number;
    measured: boolean;
  }> = [];

  for (const id of ALGORITHM_IDS) {
    if (id === "yespower") continue;

    const algo = YESPOWER_ALGORITHMS[id];
    const entry = findStatusEntry(snapshot.status, algo.poolAlgorithm);
    const port = asNumber(entry?.port);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      continue;
    }

    const factor = Math.max(
      0.000000001,
      asNumber(entry?.mbtc_mh_factor) || 1
    );

    raw.push({
      id,
      score: blendedProfit(entry) / factor,
      measured: Number(known[id] ?? 0) > 0
    });
  }

  raw.sort((a, b) => {
    if (a.measured !== b.measured) {
      return a.measured ? 1 : -1;
    }
    return b.score - a.score;
  });

  // Always verify standard YesPower plus every currently available variant.
  const ids: AlgorithmId[] = [
    "yespower",
    ...raw.map((x) => x.id)
  ];

  return Promise.all(ids.map((id) => getAlgorithmEndpoint(id)));
}
