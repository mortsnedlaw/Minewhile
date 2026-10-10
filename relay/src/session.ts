import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  config,
  isSupportedCurrency,
  type SupportedCurrency
} from "./config.js";
import { StratumSession } from "./stratum.js";
import type { BrowserJob } from "./work.js";

export const USER_MODE_DURATION_MS = 9 * 60 * 1000;
export const DEV_MODE_DURATION_MS = 60 * 1000;
export const MODE_CYCLE_MS = USER_MODE_DURATION_MS + DEV_MODE_DURATION_MS;

export type MiningMode = "user" | "dev";
export type StartRequest = {
  type: "start";
  payoutCurrency: SupportedCurrency;
  payoutAddress: string;
  workerCount: number;
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

  return {
    valid: true,
    value: { type: "start", payoutCurrency, payoutAddress, workerCount }
  };
}

// Global 9+1 minute cycle. Reconnecting does not reset the developer-fee clock.
export function getModeAt(timestampMs: number): MiningMode {
  const normalized = ((timestampMs % MODE_CYCLE_MS) + MODE_CYCLE_MS) % MODE_CYCLE_MS;
  return normalized < USER_MODE_DURATION_MS ? "user" : "dev";
}

export function getModeCountdownMsAt(timestampMs: number): number {
  const normalized = ((timestampMs % MODE_CYCLE_MS) + MODE_CYCLE_MS) % MODE_CYCLE_MS;
  return normalized < USER_MODE_DURATION_MS
    ? USER_MODE_DURATION_MS - normalized
    : MODE_CYCLE_MS - normalized;
}

type ActiveJob = BrowserJob & {
  mode: MiningMode;
  generationId: number;
};

export class MiningSession extends EventEmitter {
  readonly id = randomUUID();
  private mode: MiningMode = getModeAt(Date.now());
  private userUpstream: StratumSession | null = null;
  private devUpstream: StratumSession | null = null;
  private lastUserJob: BrowserJob | null = null;
  private lastDevJob: BrowserJob | null = null;
  private activeJob: ActiveJob | null = null;
  private generationId = 0;
  private monitorTimer: NodeJS.Timeout | null = null;
  private started = false;

  private userAccepted = 0;
  private userRejected = 0;
  private devAccepted = 0;
  private devRejected = 0;

  start(request: StartRequest) {
    if (this.started) throw new Error("Mining session is already started; stop it before starting again.");

    this.started = true;
    this.mode = getModeAt(Date.now());
    this.activeJob = null;
    this.generationId = 0;
    this.userAccepted = 0;
    this.userRejected = 0;
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
    this.devUpstream = new StratumSession({
      wallet: config.devWallet,
      password: `c=${config.devCurrency}`
    });

    this.attachUpstream(this.userUpstream, "user");
    this.attachUpstream(this.devUpstream, "dev");

    this.userUpstream.connect();
    this.devUpstream.connect();
    this.refreshMode(true);
    this.monitorTimer = setInterval(() => this.refreshMode(false), 1_000);
  }

  submit(payload: {
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

    const upstream = payload.mode === "user" ? this.userUpstream : this.devUpstream;
    if (!upstream) throw new Error(`No upstream connection for ${payload.mode} mode.`);

    return upstream.submit(payload.jobId, payload.extranonce2, payload.ntime, payload.nonceHex);
  }

  close() {
    if (!this.started && !this.userUpstream && !this.devUpstream) return;
    this.started = false;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.userUpstream?.close();
    this.devUpstream?.close();
    this.userUpstream = null;
    this.devUpstream = null;
    this.lastUserJob = null;
    this.lastDevJob = null;
    this.activeJob = null;
    this.emit("closed");
  }

  private attachUpstream(upstream: StratumSession, mode: MiningMode) {
    const publicLabel = mode === "dev" ? "MINEWHILE" : "USER";
    upstream.on("log", (message: string) => this.emit("log", `${publicLabel} ${message}`));
    upstream.on("debug", (message: string) => this.emit("debug", `${mode.toUpperCase()} ${message}`));
    upstream.on("difficulty", (value: number) => this.emit("difficulty", { mode, value }));

    upstream.on("job", (job: BrowserJob) => {
      if (mode === "user") this.lastUserJob = job;
      else this.lastDevJob = job;

      if (this.mode === mode) this.publishJob(mode, job);
    });

    upstream.on("shareResult", (x: any) => {
      const accepted = Boolean(x.accepted);
      if (mode === "user") accepted ? this.userAccepted++ : this.userRejected++;
      else accepted ? this.devAccepted++ : this.devRejected++;

      this.emit("shareResult", {
        ...x,
        mode,
        accepted,
        shares: {
          user: { accepted: this.userAccepted, rejected: this.userRejected },
          dev: { accepted: this.devAccepted, rejected: this.devRejected }
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
    const nextMode = getModeAt(now);
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
      countdownMs: getModeCountdownMsAt(now)
    });

    if (changed || forceEmit) {
      const job = this.mode === "user" ? this.lastUserJob : this.lastDevJob;
      if (job) this.publishJob(this.mode, job);
      else this.emit("pause", { mode: this.mode, reason: "Waiting for an upstream job" });
    }
  }
}
