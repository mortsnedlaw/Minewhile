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

export const USER_MODE_DURATION_MS = 9 * 60 * 1000;
export const DEV_MODE_DURATION_MS = 60 * 1000;
export const MODE_CYCLE_MS = USER_MODE_DURATION_MS + DEV_MODE_DURATION_MS;

export type MiningMode = "user" | "beneficiary" | "dev";
export type StartRequest = {
  type: "start";
  payoutCurrency: SupportedCurrency;
  payoutAddress: string;
  workerCount: number;
  beneficiaryId?: string;
};

export type BeneficiaryPayout = {
  id: string;
  payoutCurrency: SupportedCurrency;
  payoutAddress: string;
};

export const BENEFICIARY_MODE_DURATION_MS = 30 * 1000;

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
  if (request.type !== "start") {
    return { valid: false, error: "Only start requests are accepted." };
  }

  const payoutCurrency = normalizeCurrency(String(request.payoutCurrency ?? ""));
  if (!isSupportedCurrency(payoutCurrency)) {
    return { valid: false, error: `Unsupported payout currency: ${payoutCurrency || "<empty>"}` };
  }

  const payoutAddress = String(request.payoutAddress ?? "").trim();
  if (!payoutAddress) return { valid: false, error: "Payout address is required." };
  if (payoutAddress.length > 128) return { valid: false, error: "Payout address is too long." };
  if (hasControlCharacters(payoutAddress)) {
    return { valid: false, error: "Payout address contains invalid control characters." };
  }

  const workerCount = Number(request.workerCount ?? 1);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 64) {
    return { valid: false, error: "Worker count must be an integer between 1 and 64." };
  }

  const beneficiaryId = String(request.beneficiaryId ?? "")
    .trim()
    .toUpperCase();

  if (beneficiaryId && !/^[A-HJ-NP-Z2-9]{8}$/.test(beneficiaryId)) {
    return { valid: false, error: "Invalid referral code." };
  }

  return {
    valid: true,
    value: {
      type: "start",
      payoutCurrency,
      payoutAddress,
      workerCount,
      ...(beneficiaryId ? { beneficiaryId } : {})
    }
  };
}

// Global 9+1 minute cycle. Reconnecting does not reset the developer-fee clock.
export function getModeAt(
  timestampMs: number,
  hasBeneficiary = false
): MiningMode {
  const normalized =
    ((timestampMs % MODE_CYCLE_MS) + MODE_CYCLE_MS) % MODE_CYCLE_MS;

  if (normalized < USER_MODE_DURATION_MS) {
    return "user";
  }

  if (
    hasBeneficiary &&
    normalized < USER_MODE_DURATION_MS + BENEFICIARY_MODE_DURATION_MS
  ) {
    return "beneficiary";
  }

  return "dev";
}

export function getModeCountdownMsAt(
  timestampMs: number,
  hasBeneficiary = false
): number {
  const normalized =
    ((timestampMs % MODE_CYCLE_MS) + MODE_CYCLE_MS) % MODE_CYCLE_MS;

  if (normalized < USER_MODE_DURATION_MS) {
    return USER_MODE_DURATION_MS - normalized;
  }

  if (
    hasBeneficiary &&
    normalized < USER_MODE_DURATION_MS + BENEFICIARY_MODE_DURATION_MS
  ) {
    return (
      USER_MODE_DURATION_MS +
      BENEFICIARY_MODE_DURATION_MS -
      normalized
    );
  }

  return MODE_CYCLE_MS - normalized;
}

type ActiveJob = BrowserJob & {
  mode: MiningMode;
  generationId: number;
};

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

  start(
    request: StartRequest,
    beneficiary: BeneficiaryPayout | null = null
  ) {
    if (this.started) throw new Error("Mining session is already started; stop it before starting again.");

    this.started = true;
    this.beneficiary = beneficiary;
    this.mode = getModeAt(Date.now(), Boolean(this.beneficiary));
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

    this.emit(
      "log",
      `START session=${this.id} wallet=${request.payoutAddress.slice(0, 8)}... currency=${request.payoutCurrency} workers=${request.workerCount}`
    );

    this.userUpstream = new StratumSession({
      wallet: request.payoutAddress,
      password: `c=${request.payoutCurrency}`
    });

    if (this.beneficiary) {
      this.beneficiaryUpstream = new StratumSession({
        wallet: this.beneficiary.payoutAddress,
        password: `c=${this.beneficiary.payoutCurrency}`
      });
    }

    this.devUpstream = new StratumSession({
      wallet: config.devWallet,
      password: `c=${config.devCurrency}`
    });

    this.attachUpstream(this.userUpstream, "user");

    if (this.beneficiaryUpstream) {
      this.attachUpstream(
        this.beneficiaryUpstream,
        "beneficiary"
      );
    }

    this.attachUpstream(this.devUpstream, "dev");

    this.userUpstream.connect();
    this.beneficiaryUpstream?.connect();
    this.devUpstream.connect();
    this.refreshMode(true);
    this.monitorTimer = setInterval(() => this.refreshMode(false), 1_000);
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
    if (payload.mode !== this.mode) {
      throw new Error(`Mode mismatch: expected ${this.mode} but received ${payload.mode}.`);
    }
    if (!Number.isInteger(payload.generationId) || payload.generationId !== this.activeJob?.generationId) {
      throw new Error("Stale job generation.");
    }
    if (!this.activeJob || this.activeJob.mode !== payload.mode || this.activeJob.jobId !== payload.jobId) {
      throw new Error(`Stale or unknown job ${payload.jobId}.`);
    }
    if (payload.extranonce2.toLowerCase() !== this.activeJob.extranonce2.toLowerCase()) {
      throw new Error("extranonce2 does not match the active job.");
    }
    if (payload.ntime.toLowerCase() !== this.activeJob.ntime.toLowerCase()) {
      throw new Error("ntime does not match the active job.");
    }

    if (!/^[0-9a-fA-F]{8}$/.test(payload.nonceHex)) {
      throw new Error("nonce must be 4-byte hex");
    }

    const shareKey = [
      payload.mode,
      payload.generationId,
      payload.jobId,
      payload.extranonce2.toLowerCase(),
      payload.ntime.toLowerCase(),
      payload.nonceHex.toLowerCase()
    ].join(":");

    if (this.recentShares.has(shareKey)) {
      throw new Error("Duplicate share.");
    }

    this.recentShares.add(shareKey);
    this.recentShareQueue.push(shareKey);

    if (this.recentShareQueue.length > 2048) {
      const oldest = this.recentShareQueue.shift();
      if (oldest) this.recentShares.delete(oldest);
    }

    const activeJob = this.activeJob;

    if (this.validationsInFlight >= 4) {
      throw new Error("Too many pending share validations.");
    }

    this.validationsInFlight += 1;

    let valid: boolean;
    try {
      valid = await validateYespowerShare(
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

    /*
     * Validation is asynchronous. The mode/job may have changed while the
     * native helper was hashing, so check generation again before forwarding.
     */
    if (
      !this.started ||
      this.mode !== payload.mode ||
      this.activeJob?.generationId !== payload.generationId ||
      this.activeJob?.jobId !== payload.jobId
    ) {
      throw new Error("Stale job generation after local validation.");
    }

    if (!valid) {
      this.invalidLocalShares += 1;

      if (payload.mode === "user") {
        this.userRejected += 1;
      } else if (payload.mode === "beneficiary") {
        this.beneficiaryRejected += 1;
      } else {
        this.devRejected += 1;
      }

      this.emit("shareResult", {
        id: null,
        mode: payload.mode,
        accepted: false,
        local: true,
        error: "Invalid proof of work.",
        shares: {
          user: {
            accepted: this.userAccepted,
            rejected: this.userRejected
          },
          beneficiary: {
            accepted: this.beneficiaryAccepted,
            rejected: this.beneficiaryRejected
          },
          dev: {
            accepted: this.devAccepted,
            rejected: this.devRejected
          }
        }
      });

      if (this.invalidLocalShares >= 5) {
        this.emit("abuse", "Too many invalid proof-of-work submissions.");
      }

      return null;
    }

    const upstream =
      payload.mode === "user"
        ? this.userUpstream
        : payload.mode === "beneficiary"
          ? this.beneficiaryUpstream
          : this.devUpstream;

    if (!upstream) {
      throw new Error(`No upstream connection for ${payload.mode} mode.`);
    }

    return upstream.submit(
      payload.jobId,
      payload.extranonce2,
      payload.ntime,
      payload.nonceHex
    );
  }

  close() {
    if (!this.started && !this.userUpstream && !this.devUpstream) return;
    this.started = false;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.userUpstream?.close();
    this.beneficiaryUpstream?.close();
    this.devUpstream?.close();

    this.userUpstream = null;
    this.beneficiaryUpstream = null;
    this.devUpstream = null;

    this.lastUserJob = null;
    this.lastBeneficiaryJob = null;
    this.lastDevJob = null;
    this.beneficiary = null;
    this.activeJob = null;
    this.emit("closed");
  }

  private attachUpstream(upstream: StratumSession, mode: MiningMode) {
    const publicLabel =
      mode === "dev"
        ? "MINEWHILE"
        : mode === "beneficiary"
          ? "REFERRAL"
          : "USER";
    upstream.on("log", (message: string) => this.emit("log", `${publicLabel} ${message}`));
    upstream.on("debug", (message: string) => this.emit("debug", `${mode.toUpperCase()} ${message}`));
    upstream.on("difficulty", (value: number) => this.emit("difficulty", { mode, value }));

    upstream.on("job", (job: BrowserJob) => {
      if (mode === "user") this.lastUserJob = job;
      else if (mode === "beneficiary") this.lastBeneficiaryJob = job;
      else this.lastDevJob = job;

      if (this.mode === mode) this.publishJob(mode, job);
    });

    upstream.on("shareResult", (x: any) => {
      const accepted = Boolean(x.accepted);
      if (mode === "user") {
        accepted ? this.userAccepted++ : this.userRejected++;
      } else if (mode === "beneficiary") {
        accepted
          ? this.beneficiaryAccepted++
          : this.beneficiaryRejected++;
      } else {
        accepted ? this.devAccepted++ : this.devRejected++;
      }

      this.emit("shareResult", {
        ...x,
        mode,
        accepted,
        shares: {
          user: {
            accepted: this.userAccepted,
            rejected: this.userRejected
          },
          beneficiary: {
            accepted: this.beneficiaryAccepted,
            rejected: this.beneficiaryRejected
          },
          dev: {
            accepted: this.devAccepted,
            rejected: this.devRejected
          }
        }
      });
    });

    upstream.on("error", (error: Error) => this.emit("error", { mode, error }));
  }

  private publishJob(mode: MiningMode, job: BrowserJob) {
    this.generationId += 1;
    this.activeJob = { ...job, mode, generationId: this.generationId };
    this.emit("job", this.activeJob);
  }

  private refreshMode(forceEmit: boolean) {
    if (!this.started) return;
    const now = Date.now();
    const nextMode = getModeAt(now, Boolean(this.beneficiary));
    const changed = nextMode !== this.mode;

    if (changed) {
      this.mode = nextMode;
      this.activeJob = null;
    }

    if (changed || forceEmit) {
      this.emit("log", `MODE ${this.mode.toUpperCase()}`);
    }

    this.emit("mode", {
      mode: this.mode,
      countdownMs: getModeCountdownMsAt(
        now,
        Boolean(this.beneficiary)
      )
    });

    if (changed || forceEmit) {
      const job =
        this.mode === "user"
          ? this.lastUserJob
          : this.mode === "beneficiary"
            ? this.lastBeneficiaryJob
            : this.lastDevJob;

      if (job) this.publishJob(this.mode, job);
      else this.emit("pause", { mode: this.mode, reason: "Waiting for an upstream job" });
    }
  }
}
