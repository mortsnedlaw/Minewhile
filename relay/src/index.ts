import type { IncomingMessage } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import {
  assertRuntimeConfig,
  config,
  isAllowedOrigin,
  isSupportedCurrency
} from "./config.js";
import { SlidingWindowRateLimiter } from "./rateLimit.js";
import { getWalletStats } from "./poolStats.js";
import {
  createBeneficiary,
  getBeneficiary
} from "./beneficiary.js";
import {
  getAlgorithmRecommendation,
  schedulerMode
} from "./algoScheduler.js";
import { MiningSession, validateStartRequest, type MiningMode } from "./session.js";

assertRuntimeConfig();

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const MAX_CONNECTIONS_PER_IP = envInt("MAX_CONNECTIONS_PER_IP", 4, 1, 100);
const MAX_GLOBAL_CONNECTIONS = envInt("MAX_GLOBAL_CONNECTIONS", 500, 1, 100_000);
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = envInt("MAX_CONNECTION_ATTEMPTS_PER_MINUTE", 20, 1, 10_000);

const activeConnectionsByIp = new Map<string, number>();
const beneficiaryCreatesByIp =
  new Map<string, SlidingWindowRateLimiter>();
const connectionAttemptsByIp = new Map<string, SlidingWindowRateLimiter>();
let activeConnections = 0;

function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLoopback) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first?.trim()) return first.trim();
  }
  return remote;
}

function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

const wss = new WebSocketServer({
  host: config.relayHost,
  port: config.relayPort,
  maxPayload: 16_384,
  perMessageDeflate: false
});
console.log(`Relay listening on ${config.relayHost}:${config.relayPort}`);
console.log(`Allowed browser origin(s): ${config.webOrigins.join(", ")}`);

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  const ip = clientIp(req);

  if (!isAllowedOrigin(origin)) {
    console.warn("Rejected browser origin", { ip, origin });
    ws.close(1008, "Origin not allowed");
    return;
  }

  let connectionAttempts = connectionAttemptsByIp.get(ip);
  if (!connectionAttempts) {
    connectionAttempts = new SlidingWindowRateLimiter(MAX_CONNECTION_ATTEMPTS_PER_MINUTE, 60_000);
    connectionAttemptsByIp.set(ip, connectionAttempts);
  }

  if (!connectionAttempts.allow()) {
    ws.close(1013, "Too many connection attempts");
    return;
  }

  const currentConnections = activeConnectionsByIp.get(ip) ?? 0;
  if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, "Too many connections");
    return;
  }

  if (activeConnections >= MAX_GLOBAL_CONNECTIONS) {
    ws.close(1013, "Relay capacity reached");
    return;
  }

  activeConnectionsByIp.set(ip, currentConnections + 1);
  activeConnections += 1;

  console.log("BROWSER CONNECT", {
    ip,
    origin,
    activeConnections
  });

  const session = new MiningSession();
  const allMessages = new SlidingWindowRateLimiter(600, 60_000);
  const startMessages = new SlidingWindowRateLimiter(4, 60_000);
  const submitMessages = new SlidingWindowRateLimiter(300, 60_000);
  const statsMessages = new SlidingWindowRateLimiter(6, 60_000);
  const benchmarkMessages = new SlidingWindowRateLimiter(2, 60_000);
  let activeWallet: string | null = null;
  let closed = false;

  const send = (x: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(x));
  };

  session.on("log", (message: string) => {
    console.log(`[${ip}] ${message}`);
    send({ type: "log", message });
  });
  session.on("debug", (message: string) => {
    console.debug(`[${ip}] DEBUG ${message}`);
  });
  session.on("difficulty", (payload: { mode: string; value: number }) => send({ type: "difficulty", ...payload }));
  session.on("job", (job: any) => send({ type: "job", ...job }));
  session.on("pause", (payload: any) => send({ type: "pause", ...payload }));
  session.on("mode", (payload: { mode: string; countdownMs: number }) => send({ type: "mode", ...payload }));
  session.on("shareResult", (payload: any) => send({ type: "share_result", ...payload }));
  session.on("error", (payload: any) => {
    const error = payload?.error ?? payload;
    console.error(`[${ip}]`, error);
    const message =
      error instanceof Error && /Authorization rejected/i.test(error.message)
        ? "Payout address/currency was rejected by the mining backend."
        : "Mining backend error.";
    send({ type: "error", message });
  });
  session.on("closed", () => send({ type: "stopped" }));
  session.on("abuse", (reason: string) => {
    console.warn("BROWSER ABUSE", { ip, reason });
    send({ type: "error", message: reason });
    ws.close(1008, "Invalid proof of work");
  });

  ws.on("message", (raw) => {
    if (!allMessages.allow()) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    let message: any;
    try {
      message = JSON.parse(rawDataToString(raw));
    } catch {
      send({ type: "error", message: "Invalid JSON." });
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
      send({ type: "error", message: "Invalid message." });
      return;
    }

    if (message.type === "beneficiary_create") {
      let limiter = beneficiaryCreatesByIp.get(ip);

      if (!limiter) {
        limiter = new SlidingWindowRateLimiter(
          5,
          60 * 60 * 1000
        );
        beneficiaryCreatesByIp.set(ip, limiter);
      }

      if (!limiter.allow()) {
        send({
          type: "error",
          message: "Referral creation limit reached. Try again later."
        });
        return;
      }

      const payoutCurrency =
        String(message.payoutCurrency ?? "")
          .trim()
          .toUpperCase();

      const payoutAddress =
        String(message.payoutAddress ?? "")
          .trim();

      if (!isSupportedCurrency(payoutCurrency)) {
        send({
          type: "error",
          message: "Unsupported referral payout currency."
        });
        return;
      }

      if (
        !payoutAddress ||
        payoutAddress.length > 128 ||
        /[\x00-\x1F\x7F]/.test(payoutAddress)
      ) {
        send({
          type: "error",
          message: "Invalid referral payout address."
        });
        return;
      }

      try {
        const created = createBeneficiary(
          payoutCurrency,
          payoutAddress
        );

        console.log("BENEFICIARY CREATED", {
          ip,
          id: created.beneficiary.id,
          currency: created.beneficiary.payoutCurrency
        });

        send({
          type: "beneficiary_created",
          beneficiaryId: created.beneficiary.id,
          payoutCurrency: created.beneficiary.payoutCurrency,
          payoutAddress: created.beneficiary.payoutAddress,

          // Returned once. Persistent storage contains only the hash.
          managementSecret: created.managementSecret
        });
      } catch (error) {
        console.error("BENEFICIARY CREATE ERROR", error);

        send({
          type: "error",
          message: "Could not create referral."
        });
      }

      return;
    }

    if (message.type === "start") {
      if (!startMessages.allow()) {
        send({ type: "error", message: "Too many start requests." });
        return;
      }
      const check = validateStartRequest(message);
      if (!check.valid) {
        send({ type: "error", message: check.error });
        return;
      }
      try {
        const beneficiary = check.value.beneficiaryId
          ? getBeneficiary(check.value.beneficiaryId)
          : null;

        if (check.value.beneficiaryId && !beneficiary) {
          send({
            type: "error",
            message: "Referral code was not found or is disabled."
          });
          return;
        }

        session.start(
          check.value,
          beneficiary
            ? {
                id: beneficiary.id,
                payoutCurrency: beneficiary.payoutCurrency as any,
                payoutAddress: beneficiary.payoutAddress
              }
            : null
        );

        activeWallet = check.value.payoutAddress;
        send({
          type: "started",
          payoutCurrency: check.value.payoutCurrency,
          payoutAddress: check.value.payoutAddress,
          workerCount: check.value.workerCount,
          beneficiaryId: beneficiary?.id ?? null,
          schedulerMode,
          currentAlgorithm: "yespower"
        });
      } catch (error: any) {
        send({ type: "error", message: error?.message ?? String(error) });
      }
      return;
    }

    if (message.type === "stop") {
      activeWallet = null;
      session.close();
      return;
    }


    if (message.type === "benchmark") {
      if (!benchmarkMessages.allow()) {
        send({
          type: "error",
          message: "Algorithm benchmark rate limit exceeded."
        });
        return;
      }

      if (!activeWallet) {
        send({
          type: "error",
          message: "Start mining before submitting an algorithm benchmark."
        });
        return;
      }

      void getAlgorithmRecommendation(message.results)
        .then((recommendation) => {
          console.log("ALGO SHADOW", {
            ip,
            selected: recommendation.selected?.id ?? null,
            fleetEstimate: recommendation.fleetEstimate,
            topScore: recommendation.selected?.score ?? null
          });

          send({
            type: "algorithm_recommendation",
            ...recommendation
          });
        })
        .catch((error) => {
          console.warn(
            `[${ip}] algorithm scheduler unavailable`,
            error instanceof Error ? error.message : String(error)
          );

          send({
            type: "algorithm_recommendation",
            mode: schedulerMode,
            selected: null,
            ranked: [],
            error: "Profitability data temporarily unavailable."
          });
        });

      return;
    }

    if (message.type === "stats") {
      if (!statsMessages.allow()) {
        send({ type: "error", message: "Stats refresh rate limit exceeded." });
        return;
      }
      if (!activeWallet) {
        send({ type: "error", message: "Start mining before requesting wallet stats." });
        return;
      }
      void getWalletStats(activeWallet)
        .then((stats) => send({ type: "wallet_stats", ...stats }))
        .catch(() => send({ type: "error", message: "Mining statistics are temporarily unavailable." }));
      return;
    }

    if (message.type === "submit") {
      if (!submitMessages.allow()) {
        send({ type: "error", message: "Share submission rate limit exceeded." });
        return;
      }
      try {
        const mode: MiningMode =
          message.mode === "dev"
            ? "dev"
            : message.mode === "beneficiary"
              ? "beneficiary"
              : "user";
        void session.submit({
          jobId: String(message.jobId ?? ""),
          extranonce2: String(message.extranonce2 ?? ""),
          ntime: String(message.ntime ?? ""),
          nonceHex: String(message.nonceHex ?? ""),
          mode,
          generationId: Number(message.generationId)
        }).catch((error: any) => {
          console.warn(`[${ip}] share rejected locally`, error?.message ?? String(error));
          send({
            type: "error",
            message: error?.message ?? "Share validation failed."
          });
        });
      } catch (error: any) {
        send({ type: "error", message: error?.message ?? String(error) });
      }
      return;
    }

    send({ type: "error", message: `Unknown message type: ${message.type}` });
  });

  ws.on("close", () => {
    if (closed) return;
    closed = true;
    activeWallet = null;
    session.close();
    const nextCount = Math.max(0, (activeConnectionsByIp.get(ip) ?? 1) - 1);
    if (nextCount === 0) activeConnectionsByIp.delete(ip);
    else activeConnectionsByIp.set(ip, nextCount);

    activeConnections = Math.max(0, activeConnections - 1);
    console.log("BROWSER CLOSED", { ip, activeConnections });
  });
});
