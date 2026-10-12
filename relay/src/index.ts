import { adminCreateMiner, adminRemoveMiner, adminPatchMiner, adminRecordShare, adminRecordBenchmarks, createAdminChallenge, verifyAdminResponse, getAdminSnapshot } from "./admin.js";
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
  getBeneficiary,
  getBeneficiaryForManagement,
  incrementBeneficiaryStats,
  updateBeneficiary
} from "./beneficiary.js";
import {
  getAlgorithmEndpoint,
  getAlgorithmRecommendation,
  getTunePlan,
  schedulerMode
} from "./algoScheduler.js";
import {
  MiningSession,
  USER_MODE_DURATION_MS,
  validateStartRequest,
  type MiningMode
} from "./session.js";
import { TuningSession } from "./tuningSession.js";
import {
  isAlgorithmVerified,
  listVerifiedAlgorithms
} from "./algorithmVerification.js";
import type { AlgorithmId } from "./algorithms.js";

assertRuntimeConfig();

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const MAX_CONNECTIONS_PER_IP = envInt("MAX_CONNECTIONS_PER_IP", 4, 1, 100);
const MAX_GLOBAL_CONNECTIONS = envInt("MAX_GLOBAL_CONNECTIONS", 500, 1, 100_000);
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = envInt("MAX_CONNECTION_ATTEMPTS_PER_MINUTE", 20, 1, 10_000);
const AUTO_SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
const AUTO_SWITCH_HYSTERESIS = 1.08;

const activeConnectionsByIp = new Map<string, number>();
const beneficiaryCreatesByIp = new Map<string, SlidingWindowRateLimiter>();
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
  console.log("BROWSER CONNECT", { ip, origin, activeConnections });

  const session = new MiningSession();
  adminCreateMiner(session.id, ip);
  const adminChallenge = createAdminChallenge();
  let adminAuthenticated = false;

  let tune: TuningSession | null = null;
  const allMessages = new SlidingWindowRateLimiter(900, 60_000);
  const startMessages = new SlidingWindowRateLimiter(4, 60_000);
  const submitMessages = new SlidingWindowRateLimiter(450, 60_000);
  const statsMessages = new SlidingWindowRateLimiter(6, 60_000);
  const benchmarkMessages = new SlidingWindowRateLimiter(4, 60_000);
  const tuneMessages = new SlidingWindowRateLimiter(3, 60 * 60_000);
  const manageMessages = new SlidingWindowRateLimiter(20, 60_000);

  let activeWallet: string | null = null;
  let activeBeneficiaryId: string | null = null;
  let requestedAlgorithmMode: "auto" | "fixed" = "auto";
  let currentAlgorithm: AlgorithmId = "yespower";
  let lastAlgoSwitchAt = 0;
  let closed = false;

  const send = (x: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(x));
  };
  session.on("log", (message: string) => {
    console.log(`[${ip}] ${message}`);
    send({ type: "log", message });
  });
  session.on("debug", (message: string) => console.debug(`[${ip}] DEBUG ${message}`));
  session.on("difficulty", (payload: any) => {
    if (!tune) send({ type: "difficulty", ...payload });
  });
  session.on("job", (job: any) => {
    if (!tune) send({ type: "job", ...job });
  });
  session.on("pause", (payload: any) => {
    if (!tune) send({ type: "pause", ...payload });
  });
  session.on("mode", (payload: any) => {
    if (!tune) send({ type: "mode", ...payload });
  });
  session.on("health", (payload: any) => {
    if (!tune) send({ type: "health", ...payload });
  });
  session.on("algorithm", (payload: any) => {
    currentAlgorithm = payload.algorithmId as AlgorithmId;
    send({ type: "algorithm_switched", algorithmId: currentAlgorithm });
  });
  session.on("shareResult", (payload: any) => {
    if (payload.mode === "beneficiary" && activeBeneficiaryId) {
      try { incrementBeneficiaryStats(activeBeneficiaryId, Boolean(payload.accepted)); }
      catch (error) { console.warn(`[${ip}] referral stats write failed`, error); }
    }
    send({ type: "share_result", ...payload });
  });
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

  async function handleRecommendation(results: unknown) {
    const recommendation = await getAlgorithmRecommendation(results, Math.max(1, activeConnections));
    const verified = listVerifiedAlgorithms();
    const selectedVerified = recommendation.ranked.find((x) => isAlgorithmVerified(x.id)) ?? null;

    const publicCandidate = (candidate: any) => {
      if (!candidate) return null;
      const { port: _privatePort, ...publicFields } = candidate;
      return publicFields;
    };

    send({
      type: "algorithm_recommendation",
      mode: recommendation.mode,
      fleetEstimate: recommendation.fleetEstimate,
      ranked: recommendation.ranked.map(publicCandidate),
      bestOverall: publicCandidate(recommendation.selected),
      selected: publicCandidate(selectedVerified),
      verifiedAlgorithms: verified
    });

    if (
      requestedAlgorithmMode !== "auto" ||
      !selectedVerified ||
      tune ||
      !session.isStarted ||
      selectedVerified.id === currentAlgorithm
    ) return;

    const currentCandidate = recommendation.ranked.find((x) => x.id === currentAlgorithm);
    const improvement = currentCandidate && currentCandidate.score > 0
      ? selectedVerified.score / currentCandidate.score
      : Number.POSITIVE_INFINITY;

    const cooldownOk = lastAlgoSwitchAt === 0 || Date.now() - lastAlgoSwitchAt >= AUTO_SWITCH_COOLDOWN_MS;
    if (!cooldownOk || improvement < AUTO_SWITCH_HYSTERESIS) return;

    const endpoint = await getAlgorithmEndpoint(selectedVerified.id);
    session.switchAlgorithm(endpoint);
    currentAlgorithm = selectedVerified.id;
    lastAlgoSwitchAt = Date.now();

    console.log("ALGO SWITCH", {
      ip,
      algorithm: selectedVerified.id,
      improvement: Number.isFinite(improvement) ? improvement : null
    });
  }

  function attachTune(t: TuningSession) {
    t.on("plan", (payload: any) => send({ type: "tune_plan", ...payload }));
    t.on("step", (payload: any) => {
      send({ type: "pause", mode: "dev", tuning: true, reason: `Preparing ${String(payload.algorithmId ?? "tuning algorithm")}` });
      send({ type: "tune_step", ...payload });
    });
    t.on("job", (payload: any) => send({ type: "job", ...payload }));
    t.on("difficulty", (payload: any) => send({ type: "difficulty", ...payload }));
    t.on("health", (payload: any) => send({ type: "health", ...payload }));
    t.on("log", (message: string) => {
      console.log(`[${ip}] ${message}`);
      send({ type: "log", message });
    });
    t.on("shareResult", (payload: any) => send({ type: "share_result", ...payload }));
    t.on("error", (error: Error) => {
      console.warn(`[${ip}] tune error`, error.message);
      send({ type: "error", message: `Tuning: ${error.message}` });
    });
    t.on("complete", (payload: any) => {
      if (tune !== t) return;
      tune = null;
      send({ type: "tune_complete", ...payload });
      session.forceUserFor(USER_MODE_DURATION_MS);
    });
  }

  ws.on("message", (raw) => {
    if (!allMessages.allow()) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    let message: any;
    try { message = JSON.parse(rawDataToString(raw)); }
    catch { send({ type: "error", message: "Invalid JSON." }); return; }

    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
      send({ type: "error", message: "Invalid message." });
      return;
    }
if (message.type === "beneficiary_create") {
      let limiter = beneficiaryCreatesByIp.get(ip);
      if (!limiter) {
        limiter = new SlidingWindowRateLimiter(5, 60 * 60 * 1000);
        beneficiaryCreatesByIp.set(ip, limiter);
      }
      if (!limiter.allow()) {
        send({ type: "error", message: "Referral creation limit reached. Try again later." });
        return;
      }
      const payoutCurrency = String(message.payoutCurrency ?? "").trim().toUpperCase();
      const payoutAddress = String(message.payoutAddress ?? "").trim();
      if (!isSupportedCurrency(payoutCurrency)) {
        send({ type: "error", message: "Unsupported referral payout currency." });
        return;
      }
      if (!payoutAddress || payoutAddress.length > 128 || /[\x00-\x1F\x7F]/.test(payoutAddress)) {
        send({ type: "error", message: "Invalid referral payout address." });
        return;
      }
      try {
        const created = createBeneficiary(payoutCurrency, payoutAddress);
        console.log("BENEFICIARY CREATED", { ip, id: created.beneficiary.id, currency: created.beneficiary.payoutCurrency });
        send({
          type: "beneficiary_created",
          beneficiaryId: created.beneficiary.id,
          payoutCurrency: created.beneficiary.payoutCurrency,
          payoutAddress: created.beneficiary.payoutAddress,
          managementSecret: created.managementSecret
        });
      } catch (error) {
        console.error("BENEFICIARY CREATE ERROR", error);
        send({ type: "error", message: "Could not create referral." });
      }
      return;
    }

    if (message.type === "beneficiary_manage_get") {
      if (!manageMessages.allow()) { send({ type: "error", message: "Too many management requests." }); return; }
      const result = getBeneficiaryForManagement(String(message.beneficiaryId ?? ""), String(message.managementSecret ?? ""));
      if (!result) { send({ type: "error", message: "Invalid referral management credentials." }); return; }
      send({ type: "beneficiary_management", beneficiary: result });
      return;
    }

    if (message.type === "beneficiary_manage_update") {
      if (!manageMessages.allow()) { send({ type: "error", message: "Too many management requests." }); return; }
      const currency = String(message.payoutCurrency ?? "").trim().toUpperCase();
      if (!isSupportedCurrency(currency)) { send({ type: "error", message: "Unsupported referral payout currency." }); return; }
      try {
        const result = updateBeneficiary(
          String(message.beneficiaryId ?? ""),
          String(message.managementSecret ?? ""),
          currency,
          String(message.payoutAddress ?? ""),
          message.enabled !== false
        );
        send({ type: "beneficiary_management", beneficiary: result });
      } catch {
        send({ type: "error", message: "Could not update referral." });
      }
      return;
    }

    if (message.type === "start") {
      if (!startMessages.allow()) { send({ type: "error", message: "Too many start requests." }); return; }
      const check = validateStartRequest(message);
      if (!check.valid) { send({ type: "error", message: check.error }); return; }

      void (async () => {
        try {
          const beneficiary = check.value.beneficiaryId ? getBeneficiary(check.value.beneficiaryId) : null;
          if (check.value.beneficiaryId && !beneficiary) {
            send({ type: "error", message: "Referral code was not found or is disabled." });
            return;
          }

          requestedAlgorithmMode = check.value.algorithmMode;
          let initialAlgorithm: AlgorithmId = check.value.algorithmMode === "fixed" ? check.value.algorithmId : "yespower";
          if (initialAlgorithm !== "yespower" && !isAlgorithmVerified(initialAlgorithm)) {
            send({ type: "error", message: "That algorithm is not yet verified by a real accepted Minewhile canary share." });
            return;
          }
          const endpoint = await getAlgorithmEndpoint(initialAlgorithm);
          session.start(
            check.value,
            beneficiary
              ? { id: beneficiary.id, payoutCurrency: beneficiary.payoutCurrency as any, payoutAddress: beneficiary.payoutAddress }
              : null,
            endpoint
          );

          activeWallet = check.value.payoutAddress;
        adminPatchMiner(session.id, { startedAt: Date.now(), workerCount: check.value.workerCount, payoutCurrency: check.value.payoutCurrency, payoutAddressMasked: check.value.payoutAddress.slice(0,6) + "…" + check.value.payoutAddress.slice(-4), beneficiaryId: beneficiary?.id ?? null, mode: "user" });
          activeBeneficiaryId = beneficiary?.id ?? null;
          currentAlgorithm = initialAlgorithm;
          send({
            type: "started",
            payoutCurrency: check.value.payoutCurrency,
            payoutAddress: check.value.payoutAddress,
            workerCount: check.value.workerCount,
            beneficiaryId: activeBeneficiaryId,
            schedulerMode,
            algorithmMode: requestedAlgorithmMode,
            currentAlgorithm,
            verifiedAlgorithms: listVerifiedAlgorithms()
          });
        } catch (error: any) {
          send({ type: "error", message: error?.message ?? String(error) });
        }
      })();
      return;
    }

    if (message.type === "stop") {
      tune?.close();
      tune = null;
      activeWallet = null;
      activeBeneficiaryId = null;
      adminPatchMiner(session.id, { startedAt: null, mode: "stopped", tuning: false });
      session.close();
      return;
    }

    if (message.type === "tune_start") {
      if (!tuneMessages.allow()) { send({ type: "error", message: "Quick Tune can be run at most three times per hour." }); return; }
      if (!activeWallet || !session.isStarted) { send({ type: "error", message: "Start mining before Quick Tune." }); return; }
      if (tune) { send({ type: "error", message: "Quick Tune is already running." }); return; }

      void getTunePlan(message.results)
        .then((plan) => {
          if (!plan.length) throw new Error("No tune candidates available.");
          const t = new TuningSession(plan);
          tune = t;
          attachTune(t);
          t.start();
        })
        .catch((error) => send({ type: "error", message: `Could not start Quick Tune: ${error instanceof Error ? error.message : String(error)}` }));
      return;
    }

    if (message.type === "benchmark") {
      if (!benchmarkMessages.allow()) { send({ type: "error", message: "Algorithm profile rate limit exceeded." }); return; }
      if (!activeWallet) { send({ type: "error", message: "Start mining before submitting an algorithm profile." }); return; }
      void handleRecommendation(message.results).catch((error) => {
        console.warn(`[${ip}] algorithm scheduler unavailable`, error instanceof Error ? error.message : String(error));
        send({ type: "algorithm_recommendation", mode: schedulerMode, selected: null, ranked: [], error: "Profitability data temporarily unavailable.", verifiedAlgorithms: listVerifiedAlgorithms() });
      });
      return;
    }

    if (message.type === "stats") {
      if (!statsMessages.allow()) { send({ type: "error", message: "Stats refresh rate limit exceeded." }); return; }
      if (!activeWallet) { send({ type: "error", message: "Start mining before requesting wallet stats." }); return; }
      void getWalletStats(activeWallet)
        .then((stats) => send({ type: "wallet_stats", ...stats }))
        .catch(() => send({ type: "stats_error", message: "Mining statistics are temporarily unavailable." }));
      return;
    }

    if (message.type === "submit") {
      if (!submitMessages.allow()) { send({ type: "error", message: "Share submission rate limit exceeded." }); return; }
      if (message.tuning === true) {
        if (!tune) { send({ type: "error", message: "No active tuning session." }); return; }
        void tune.submit({
          jobId: String(message.jobId ?? ""),
          extranonce2: String(message.extranonce2 ?? ""),
          ntime: String(message.ntime ?? ""),
          nonceHex: String(message.nonceHex ?? ""),
          generationId: Number(message.generationId),
          tuneId: String(message.tuneId ?? "")
        }).catch((error: any) => send({ type: "error", message: error?.message ?? "Tuning share validation failed." }));
        return;
      }

      const mode: MiningMode = message.mode === "dev" ? "dev" : message.mode === "beneficiary" ? "beneficiary" : "user";
      void session.submit({
        jobId: String(message.jobId ?? ""),
        extranonce2: String(message.extranonce2 ?? ""),
        ntime: String(message.ntime ?? ""),
        nonceHex: String(message.nonceHex ?? ""),
        mode,
        generationId: Number(message.generationId)
      }).catch((error: any) => {
        console.warn(`[${ip}] share rejected locally`, error?.message ?? String(error));
        send({ type: "error", message: error?.message ?? "Share validation failed." });
      });
      return;
    }

    send({ type: "error", message: `Unknown message type: ${message.type}` });
  });

  ws.on("close", () => {
    if (closed) return;
    closed = true;
    tune?.close();
    tune = null;
    activeWallet = null;
    activeBeneficiaryId = null;
    session.close();
    const nextCount = Math.max(0, (activeConnectionsByIp.get(ip) ?? 1) - 1);
    if (nextCount === 0) activeConnectionsByIp.delete(ip);
    else activeConnectionsByIp.set(ip, nextCount);
    activeConnections = Math.max(0, activeConnections - 1);
    adminRemoveMiner(session.id);
    console.log("BROWSER CLOSED", { ip, activeConnections });
  });
});
