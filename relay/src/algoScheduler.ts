import {
  ALGORITHM_IDS,
  YESPOWER_ALGORITHMS,
  type AlgorithmId
} from "./algorithms.js";

const API_BASE = "https://www.zpool.ca/api";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_MS = 60_000;

export const schedulerMode =
  (process.env.ALGO_MODE ?? "shadow").trim().toLowerCase();

const fleetEstimateRaw =
  Number(process.env.ALGO_FLEET_ESTIMATE ?? "100");

const FLEET_ESTIMATE =
  Number.isFinite(fleetEstimateRaw) &&
  fleetEstimateRaw >= 1 &&
  fleetEstimateRaw <= 1_000_000
    ? fleetEstimateRaw
    : 100;

type JsonObject = Record<string, any>;

let cache: {
  expiresAt: number;
  status: JsonObject;
  currencies: JsonObject;
} | null = null;

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(path: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        "user-agent": "Minewhile/0.10"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Zpool API ${path} returned HTTP ${response.status}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getPoolSnapshot() {
  const now = Date.now();

  if (cache && cache.expiresAt > now) {
    return cache;
  }

  const [statusRaw, currenciesRaw] = await Promise.all([
    fetchJson("/status"),
    fetchJson("/currencies")
  ]);

  const status =
    statusRaw &&
    typeof statusRaw === "object" &&
    !Array.isArray(statusRaw)
      ? statusRaw
      : {};

  const currencies =
    currenciesRaw &&
    typeof currenciesRaw === "object" &&
    !Array.isArray(currenciesRaw)
      ? currenciesRaw
      : {};

  cache = {
    expiresAt: now + CACHE_MS,
    status,
    currencies
  };

  return cache;
}

function findStatusEntry(
  status: JsonObject,
  poolAlgorithm: string
): any | null {
  const wanted = poolAlgorithm.toLowerCase();

  for (const [key, value] of Object.entries(status)) {
    const name = String(
      (value as any)?.name ?? key
    ).toLowerCase();

    if (
      key.toLowerCase() === wanted ||
      name === wanted
    ) {
      return value;
    }
  }

  return null;
}

function networkHashrateForAlgorithm(
  currencies: JsonObject,
  poolAlgorithm: string
): number {
  const wanted = poolAlgorithm.toLowerCase();

  let total = 0;

  for (const value of Object.values(currencies)) {
    const algo = String(
      (value as any)?.algo ?? ""
    ).toLowerCase();

    if (algo !== wanted) continue;

    const h = asNumber((value as any)?.hashrate);

    if (h > 0) {
      total += h;
    }
  }

  return total;
}

export type AlgorithmCandidate = {
  id: AlgorithmId;
  displayName: string;
  poolAlgorithm: string;
  port: number;
  benchmarkHps: number;
  poolHashrate: number;
  networkHashrate: number;
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
  fleetEstimate = FLEET_ESTIMATE
): AlgorithmCandidate[] {
  const ranked: AlgorithmCandidate[] = [];

  for (const id of ALGORITHM_IDS) {
    const algo = YESPOWER_ALGORITHMS[id];
    const entry = findStatusEntry(
      status,
      algo.poolAlgorithm
    );

    if (!entry) continue;

    const port = asNumber(entry.port);
    const benchmarkHps =
      asNumber(benchmarks[id]);

    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      benchmarkHps <= 0
    ) {
      continue;
    }

    const estimateCurrent =
      asNumber(entry.estimate_current);

    const estimate24h =
      asNumber(entry.estimate_last24h);

    const factor =
      Math.max(
        0.000000001,
        asNumber(entry.mbtc_mh_factor) || 1
      );

    /*
     * Blend current and 24h estimate so a short profitability
     * spike does not immediately win the scheduler.
     */
    let blendedProfit = 0;

    if (
      estimateCurrent > 0 &&
      estimate24h > 0
    ) {
      blendedProfit =
        estimateCurrent * 0.65 +
        estimate24h * 0.35;
    } else {
      blendedProfit =
        Math.max(
          estimateCurrent,
          estimate24h
        );
    }

    const profitabilityScore =
      (blendedProfit * benchmarkHps) /
      factor;

    const poolHashrate =
      asNumber(entry.hashrate);

    const networkHashrate =
      networkHashrateForAlgorithm(
        currencies,
        algo.poolAlgorithm
      );

    const projectedMinewhileHashrate =
      benchmarkHps *
      Math.max(1, fleetEstimate);

    const impactRatio =
      networkHashrate > 0
        ? projectedMinewhileHashrate /
          networkHashrate
        : null;

    /*
     * Prefer staying below ~10% of the aggregate reported
     * network hashrate for an algorithm.
     *
     * This is a guardrail/ranking penalty, not a claim that the
     * API gives a perfect view of every network.
     */
    let impactPenalty = 1;

    if (
      impactRatio !== null &&
      impactRatio > 0.10
    ) {
      impactPenalty =
        Math.max(
          0.05,
          0.10 / impactRatio
        );
    }

    const score =
      profitabilityScore *
      impactPenalty;

    ranked.push({
      id,
      displayName: algo.displayName,
      poolAlgorithm: algo.poolAlgorithm,
      port,
      benchmarkHps,
      poolHashrate,
      networkHashrate,
      estimateCurrent,
      estimate24h,
      profitabilityScore,
      impactRatio,
      impactPenalty,
      score
    });
  }

  ranked.sort(
    (a, b) => b.score - a.score
  );

  return ranked;
}

export async function getAlgorithmRecommendation(
  benchmarkInput: unknown
) {
  const benchmarks: Record<string, number> = {};

  if (
    benchmarkInput &&
    typeof benchmarkInput === "object" &&
    !Array.isArray(benchmarkInput)
  ) {
    for (
      const [key, raw] of
      Object.entries(
        benchmarkInput as Record<string, unknown>
      )
    ) {
      if (
        !ALGORITHM_IDS.includes(
          key as AlgorithmId
        )
      ) {
        continue;
      }

      const value = Number(raw);

      if (
        Number.isFinite(value) &&
        value > 0 &&
        value < 10_000_000_000
      ) {
        benchmarks[key] = value;
      }
    }
  }

  const snapshot = await getPoolSnapshot();

  const ranked =
    rankAlgorithmCandidates(
      snapshot.status,
      snapshot.currencies,
      benchmarks
    );

  return {
    mode: schedulerMode,
    fleetEstimate: FLEET_ESTIMATE,
    selected:
      ranked[0] ?? null,
    ranked:
      ranked.slice(0, 7)
  };
}
