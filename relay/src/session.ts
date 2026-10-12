import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  config,
  isSupportedCurrency,
  type SupportedCurrency
} from "./config.js";
import { StratumSession } from "./stratum.js";
import type { BrowserJob } from "./work.js";
import { validateYespowerShare } from "./validator.js";
import { isAlgorithmId, type AlgorithmId } from "./algorithms.js";
import type { AlgorithmEndpoint } from "./algoScheduler.js";

export const USER_MODE_DURATION_MS = 9 * 60 * 1000 + 30 * 1000;
export const BENEFICIARY_MODE_DURATION_MS = 18 * 1000;
export const MODE_CYCLE_MS = 10 * 60 * 1000;

export type MiningMode = "user" | "beneficiary" | "dev";
export type AlgorithmMode = "auto" | "fixed";

export type StartRequest = {
  type: "start";
  payoutCurrency: SupportedCurrency;
  payoutAddress: string;
  workerCount: number;
  beneficiaryId?: string;
  algorithmMode: AlgorithmMode;
  algorithmId: AlgorithmId;
};

export type BeneficiaryPayout = {
  id: string;
  payoutCurrency: SupportedCurrency;
  payoutAddress: string;
};

export function normalizeCurrency(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

export function hasControlCharacters(value: string): boolean {
  return /[\x00-\x1F\x7F]/.test(value);
}

export function validateStartRequest(input: unknown): { valid: true; value: StartRequest } | { valid: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Request must be an object." };
  }
  const request = input as Record<string, unknown>;
  if (request.type !== "start") return { valid: false, error: "Only start requests are accepted." };

  const payoutCurrency = normalizeCurrency(String(request.payoutCurrency ?? ""));
  if (!isSupportedCurrency(payoutCurrency)) {
    return { valid: false, error: `Unsupported payout currency: ${payoutCurrency || "<empty>"}` };
  }

  const payoutAddress = String(request.payoutAddress ?? "").trim();
  if (!payoutAddress) return { valid: false, error: "Payout address is required." };
  if (payoutAddress.length > 128) return { valid: false, error: "Payout address is too long." };
  if (hasControlCharacters(payoutAddress)) return { valid: false, error: "Payout address contains invalid control characters." };

  const workerCount = Number(request.workerCount ?? 1);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 64) {
    return { valid: false, error: "Worker count must be an integer between 1 and 64." };
  }

  const beneficiaryId = String(request.beneficiaryId ?? "").trim().toUpperCase();
  if (beneficiaryId && !/^[A-HJ-NP-Z2-9]{8}$/.test(beneficiaryId)) {
    return { valid: false, error: "Invalid referral code." };
  }

  const algorithmMode: AlgorithmMode = request.algorithmMode === "fixed" ? "fixed" : "auto";
  const requestedAlgorithm = String(request.algorithmId ?? "yespower").trim().toLowerCase();
  if (!isAlgorithmId(requestedAlgorithm)) return { valid: false, error: "Unsupported mining algorithm." };

  return {
    valid: true,
    value: {
      type: "start",
      payoutCurrency,
      payoutAddress,
      workerCount,
      ...(beneficiaryId ? { beneficiaryId } : {}),
      algorithmMode,
      algorithmId: requestedAlgorithm
    }
  };
}

export function getModeAt(timestampMs: number, hasBeneficiary = false): MiningMode {
  const normalized = ((timestampMs % MODE_CYCLE_MS) + MODE_CYCLE_MS) % MODE_CYCLE_MS;
  if (normalized < USER_MODE_DURATION_MS) return "user";
  if (hasBeneficiary && normalized < USER_MODE_DURATION_MS + BENEFICIARY_MODE_DURATION_MS) return "beneficiary";
  return "dev";
}

export function getModeCountdownMsAt(timestampMs: number, hasBeneficiary = false): number {
  const normalized = ((timestampMs % MODE_CYCLE_MS) + MODE_CYCLE_MS) % MODE_CYCLE_MS;
  if (normalized < USER_MODE_DURATION_MS) return USER_MODE_DURATION_MS - normalized;
  if (hasBeneficiary && normalized < USER_MODE_DURATION_MS + BENEFICIARY_MODE_DURATION_MS) {
    return USER_MODE_DURATION_MS + BENEFICIARY_MODE_DURATION_MS - normalized;
  }
  return MODE_CYCLE_MS - normalized;
}

type ActiveJob = BrowserJob & { mode: MiningMode; generationId: number };

export class MiningSession extends EventEmitter {
  readonly id = randomUUID();
  private mode: MiningMode = getModeAt(Date.now());
  private userUpstream: StratumSession | null = null;
  private beneficiaryUpstream: StratumSession | null = null;
  private devUpstream: StratumSession | null = null;
  private lastUserJob: BrowserJob | null = null;
  private lastBeneficiaryJob: BrowserJob | null = null;
  private lastDevJob: BrowserJob | null = null;
  private beneficiary: BeneficiaryPayout | null = null;
  private activeJob: ActiveJob | null = null;
  private generationId = 0;
  private monitorTimer: NodeJS.Timeout | null = null;
  private started = false;
  private recentShares = new Set<string>();
  private recentShareQueue: string[] = [];
  private validationsInFlight = 0;
  private invalidLocalShares = 0;
  private userAccepted = 0;
  private userRejected = 0;
  private beneficiaryAccepted = 0;
  private beneficiaryRejected = 0;
  private devAccepted = 0;
  private devRejected = 0;
  private request: StartRequest | null = null;
  private endpoint: AlgorithmEndpoint | null = null;
  private userGraceUntil = 0;

  get currentAlgorithmId(): AlgorithmId {
    return this.endpoint?.id ?? "yespower";
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(
    request: StartRequest,
    beneficiary: BeneficiaryPayout | null,
    endpoint: AlgorithmEndpoint
  ) {
    if (this.started) throw new Error("Mining session is already started; stop it before starting again.");
    this.started = true;
    this.request = request;
    this.beneficiary = beneficiary;
    this.endpoint = endpoint;
    this.mode = getModeAt(Date.now(), Boolean(this.beneficiary));
    this.userGraceUntil = 0;
    this.activeJob = null;
    this.generationId = 0;
    this.recentShares.clear();
    this.recentShareQueue.length = 0;
    this.validationsInFlight = 0;
    this.invalidLocalShares = 0;
    this.userAccepted = 0;
    this.userRejected = 0;
    this.beneficiaryAccepted = 0;
    this.beneficiaryRejected = 0;
    this.devAccepted = 0;
    this.devRejected = 0;

    this.emit("log", `START session=${this.id} wallet=${request.payoutAddress.slice(0, 8)}... currency=${request.payoutCurrency} workers=${request.workerCount} algo=${endpoint.id}`);
    this.createUpstreams(endpoint);
    this.refreshMode(true);
    this.monitorTimer = setInterval(() => this.refreshMode(false), 1_000);
  }

  switchAlgorithm(endpoint: AlgorithmEndpoint) {
    if (!this.started || !this.request) throw new Error("Mining session is not started.");
    if (endpoint.id === this.currentAlgorithmId) return;
    this.emit("log", `ALGORITHM SWITCH ${this.currentAlgorithmId} -> ${endpoint.id}`);
    this.endpoint = endpoint;
    this.activeJob = null;
    this.lastUserJob = null;
    this.lastBeneficiaryJob = null;
    this.lastDevJob = null;
    this.closeUpstreams();
    this.createUpstreams(endpoint);
    this.emit("algorithm", { algorithmId: endpoint.id });
    this.emit("pause", { mode: this.mode, reason: "Switching mining algorithm" });
  }

  forceUserFor(durationMs: number) {
    if (!this.started) return;
    this.userGraceUntil = Date.now() + Math.max(0, durationMs);
    this.mode = "user";
    this.activeJob = null;
    this.emit("log", `POST-TUNE USER GRACE ${Math.round(durationMs / 1000)}s`);
    this.emit("mode", { mode: "user", countdownMs: durationMs });
    this.republishCurrent();
  }

  republishCurrent() {
    if (!this.started) return;
    const job = this.mode === "user"
      ? this.lastUserJob
      : this.mode === "beneficiary"
        ? this.lastBeneficiaryJob
        : this.lastDevJob;
    if (job) this.publishJob(this.mode, job);
    else this.emit("pause", { mode: this.mode, reason: "Waiting for an upstream job" });
  }

  async submit(payload: {
    jobId: string;
    extranonce2: string;
    ntime: string;
    nonceHex: string;
    mode: MiningMode;
    generationId: number;
  }) {
    if (!this.started) throw new Error("Mining session has not started.");
    if (payload.mode !== this.mode) throw new Error(`Mode mismatch: expected ${this.mode} but received ${payload.mode}.`);
    if (!Number.isInteger(payload.generationId) || payload.generationId !== this.activeJob?.generationId) throw new Error("Stale job generation.");
    if (!this.activeJob || this.activeJob.mode !== payload.mode || this.activeJob.jobId !== payload.jobId) throw new Error(`Stale or unknown job ${payload.jobId}.`);
    if (payload.extranonce2.toLowerCase() !== this.activeJob.extranonce2.toLowerCase()) throw new Error("extranonce2 does not match the active job.");
    if (payload.ntime.toLowerCase() !== this.activeJob.ntime.toLowerCase()) throw new Error("ntime does not match the active job.");
    if (!/^[0-9a-fA-F]{8}$/.test(payload.nonceHex)) throw new Error("nonce must be 4-byte hex");

    const shareKey = [payload.mode, payload.generationId, payload.jobId, payload.extranonce2.toLowerCase(), payload.ntime.toLowerCase(), payload.nonceHex.toLowerCase()].join(":");
    if (this.recentShares.has(shareKey)) throw new Error("Duplicate share.");
    this.recentShares.add(shareKey);
    this.recentShareQueue.push(shareKey);
    if (this.recentShareQueue.length > 2048) {
      const oldest = this.recentShareQueue.shift();
      if (oldest) this.recentShares.delete(oldest);
    }

    const activeJob = this.activeJob;
    if (this.validationsInFlight >= 4) throw new Error("Too many pending share validations.");
    this.validationsInFlight += 1;

    let valid: boolean;
    try {
      valid = await validateYespowerShare(
        activeJob.algorithmId,
        activeJob.header76Hex,
        activeJob.targetHex,
        payload.nonceHex
      );
    } catch (error) {
      this.recentShares.delete(shareKey);
      const queueIndex = this.recentShareQueue.indexOf(shareKey);
      if (queueIndex >= 0) this.recentShareQueue.splice(queueIndex, 1);
      throw error;
    } finally {
      this.validationsInFlight = Math.max(0, this.validationsInFlight - 1);
    }

    if (!this.started || this.mode !== payload.mode || this.activeJob?.generationId !== payload.generationId || this.activeJob?.jobId !== payload.jobId) {
      throw new Error("Stale job generation after local validation.");
    }

    if (!valid) {
      this.invalidLocalShares += 1;
      if (payload.mode === "user") this.userRejected += 1;
      else if (payload.mode === "beneficiary") this.beneficiaryRejected += 1;
      else this.devRejected += 1;
      this.emitShareResult({ id: null, mode: payload.mode, accepted: false, local: true, error: "Invalid proof of work.", algorithmId: activeJob.algorithmId });
      if (this.invalidLocalShares >= 5) this.emit("abuse", "Too many invalid proof-of-work submissions.");
      return null;
    }

    const upstream = payload.mode === "user" ? this.userUpstream : payload.mode === "beneficiary" ? this.beneficiaryUpstream : this.devUpstream;
    if (!upstream) throw new Error(`No upstream connection for ${payload.mode} mode.`);
    return upstream.submit(payload.jobId, payload.extranonce2, payload.ntime, payload.nonceHex);
  }

  close() {
    if (!this.started && !this.userUpstream && !this.devUpstream) return;
    this.started = false;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.closeUpstreams();
    this.request = null;
    this.endpoint = null;
    this.lastUserJob = null;
    this.lastBeneficiaryJob = null;
    this.lastDevJob = null;
    this.beneficiary = null;
    this.activeJob = null;
    this.emit("closed");
  }

  private closeUpstreams() {
    this.userUpstream?.close();
    this.beneficiaryUpstream?.close();
    this.devUpstream?.close();
    this.userUpstream = null;
    this.beneficiaryUpstream = null;
    this.devUpstream = null;
  }

  private createUpstreams(endpoint: AlgorithmEndpoint) {
    if (!this.request) throw new Error("Missing mining request.");
    this.userUpstream = new StratumSession({
      wallet: this.request.payoutAddress,
      password: `c=${this.request.payoutCurrency}`,
      endpoint
    });
    if (this.beneficiary) {
      this.beneficiaryUpstream = new StratumSession({
        wallet: this.beneficiary.payoutAddress,
        password: `c=${this.beneficiary.payoutCurrency}`,
        endpoint
      });
    }
    this.devUpstream = new StratumSession({
      wallet: config.devWallet,
      password: `c=${config.devCurrency}`,
      endpoint
    });

    this.attachUpstream(this.userUpstream, "user");
    if (this.beneficiaryUpstream) this.attachUpstream(this.beneficiaryUpstream, "beneficiary");
    this.attachUpstream(this.devUpstream, "dev");
    this.userUpstream.connect();
    this.beneficiaryUpstream?.connect();
    this.devUpstream.connect();
  }

  private emitShareResult(x: any) {
    this.emit("shareResult", {
      ...x,
      shares: {
        user: { accepted: this.userAccepted, rejected: this.userRejected },
        beneficiary: { accepted: this.beneficiaryAccepted, rejected: this.beneficiaryRejected },
        dev: { accepted: this.devAccepted, rejected: this.devRejected }
      }
    });
  }

  private attachUpstream(upstream: StratumSession, mode: MiningMode) {
    const publicLabel = mode === "dev" ? "MINEWHILE" : mode === "beneficiary" ? "REFERRAL" : "USER";
    upstream.on("log", (message: string) => this.emit("log", `${publicLabel} ${message}`));
    upstream.on("debug", (message: string) => this.emit("debug", `${mode.toUpperCase()} ${message}`));
    upstream.on("difficulty", (value: number) => this.emit("difficulty", { mode, value, algorithmId: upstream.algorithmId }));
    upstream.on("state", (payload: any) => this.emit("health", { mode, ...payload }));

    upstream.on("job", (job: BrowserJob) => {
      if (mode === "user") this.lastUserJob = job;
      else if (mode === "beneficiary") this.lastBeneficiaryJob = job;
      else this.lastDevJob = job;
      if (this.mode === mode) this.publishJob(mode, job);
    });

    upstream.on("shareResult", (x: any) => {
      const accepted = Boolean(x.accepted);
      if (mode === "user") accepted ? this.userAccepted++ : this.userRejected++;
      else if (mode === "beneficiary") accepted ? this.beneficiaryAccepted++ : this.beneficiaryRejected++;
      else accepted ? this.devAccepted++ : this.devRejected++;
      this.emitShareResult({ ...x, mode, accepted, algorithmId: upstream.algorithmId });
    });

    upstream.on("error", (error: Error) => this.emit("error", { mode, error, algorithmId: upstream.algorithmId }));
  }

  private publishJob(mode: MiningMode, job: BrowserJob) {
    this.generationId += 1;
    this.activeJob = { ...job, mode, generationId: this.generationId };
    this.emit("job", this.activeJob);
  }

  private refreshMode(forceEmit: boolean) {
    if (!this.started) return;
    const now = Date.now();
    const inGrace = this.userGraceUntil > now;
    const nextMode = inGrace ? "user" : getModeAt(now, Boolean(this.beneficiary));
    const countdownMs = inGrace ? this.userGraceUntil - now : getModeCountdownMsAt(now, Boolean(this.beneficiary));
    const changed = nextMode !== this.mode;
    if (changed) {
      this.mode = nextMode;
      this.activeJob = null;
    }
    if (changed || forceEmit) this.emit("log", `MODE ${this.mode.toUpperCase()}`);
    this.emit("mode", { mode: this.mode, countdownMs });
    if (changed || forceEmit) this.republishCurrent();
  }
}
