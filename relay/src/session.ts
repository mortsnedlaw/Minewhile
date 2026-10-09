import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { config, type SupportedCurrency } from "./config.js";
import { StratumSession } from "./stratum.js";
import type { BrowserJob } from "./work.js";

export const USER_MODE_DURATION_MS = 9 * 60 * 1000;
export const DEV_MODE_DURATION_MS = 60 * 1000;
export const MODE_CYCLE_MS = USER_MODE_DURATION_MS + DEV_MODE_DURATION_MS;
export const SUPPORTED_PAYOUT_CURRENCIES = ["BTC", "LTC", "DASH", "DGB", "FLUX", "RVN"] as const;

export type MiningMode = "user" | "dev";
export type StartRequest = {
  type: "start";
  payoutCurrency: string;
  payoutAddress: string;
  workerCount: number;
};

export type ShareResult = {
  mode: MiningMode;
  accepted: boolean;
  error: any;
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
  const supportedCurrencyList = SUPPORTED_PAYOUT_CURRENCIES as readonly string[];
  if (!supportedCurrencyList.includes(payoutCurrency)) {
    return { valid: false, error: `Unsupported payout currency: ${payoutCurrency || "<empty>"}` };
  }

  const payoutAddress = String(request.payoutAddress ?? "").trim();
  if (!payoutAddress) {
    return { valid: false, error: "Payout address is required." };
  }
  if (payoutAddress.length > 128) {
    return { valid: false, error: "Payout address is too long." };
  }
  if (hasControlCharacters(payoutAddress)) {
    return { valid: false, error: "Payout address contains invalid control characters." };
  }

  const workerCount = Number(request.workerCount ?? 1);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 64) {
    return { valid: false, error: "Worker count must be an integer between 1 and 64." };
  }

  return {
    valid: true,
    value: {
      type: "start",
      payoutCurrency,
      payoutAddress,
      workerCount
    }
  };
}

export function getModeForElapsed(elapsedMs: number): MiningMode {
  const modeCycle = MODE_CYCLE_MS;
  const offset = elapsedMs % modeCycle;
  return offset < USER_MODE_DURATION_MS ? "user" : "dev";
}

export function getModeCountdownMs(elapsedMs: number): number {
  const offset = elapsedMs % MODE_CYCLE_MS;
  if (offset < USER_MODE_DURATION_MS) {
    return USER_MODE_DURATION_MS - offset;
  }
  return MODE_CYCLE_MS - offset;
}

export class MiningSession extends EventEmitter {
  readonly id = randomUUID();
  private startedAt = Date.now();
  private mode: MiningMode = "user";
  private userUpstream: StratumSession | null = null;
  private devUpstream: StratumSession | null = null;
  private lastUserJob: BrowserJob | null = null;
  private lastDevJob: BrowserJob | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private payoutAddress = "";
  private payoutCurrency: SupportedCurrency | null = null;
  private workerCount = 1;
  private started = false;

  get currentMode(): MiningMode {
    return this.mode;
  }

  get shares() {
    return {
      user: { accepted: this.userAccepted, rejected: this.userRejected },
      dev: { accepted: this.devAccepted, rejected: this.devRejected }
    };
  }

  private userAccepted = 0;
  private userRejected = 0;
  private devAccepted = 0;
  private devRejected = 0;

  start(request: StartRequest) {
    if (this.started) {
      this.close();
    }

    this.payoutCurrency = normalizeCurrency(request.payoutCurrency) as SupportedCurrency;
    this.payoutAddress = String(request.payoutAddress).trim();
    this.workerCount = request.workerCount;
    this.startedAt = Date.now();
    this.mode = getModeForElapsed(0);
    this.started = true;

    this.emit("log", `START session=${this.id} wallet=${this.payoutAddress.slice(0, 8)}... currency=${this.payoutCurrency} workers=${this.workerCount}`);

    this.userUpstream = new StratumSession({
      wallet: this.payoutAddress,
      password: `c=${this.payoutCurrency}`
    });
    this.devUpstream = new StratumSession({
      wallet: config.devWallet,
      password: `c=${config.devCurrency}`
    });

    this.attachUpstream(this.userUpstream, "user");
    this.attachUpstream(this.devUpstream, "dev");

    this.userUpstream.connect();
    this.devUpstream.connect();
    this.refreshMode();

    this.monitorTimer = setInterval(() => {
      this.refreshMode();
    }, 1000);
  }

  submit(payload: {
    jobId: string;
    extranonce2: string;
    ntime: string;
    nonceHex: string;
    mode: MiningMode;
  }) {
    if (!this.started) {
      throw new Error("Mining session has not started.");
    }

    if (payload.mode !== this.mode) {
      throw new Error(`Mode mismatch: expected ${this.mode} but received ${payload.mode}.`);
    }

    const upstream = payload.mode === "user" ? this.userUpstream : this.devUpstream;
    const activeJob = payload.mode === "user" ? this.lastUserJob : this.lastDevJob;

    if (!upstream) {
      throw new Error(`No upstream connection for ${payload.mode} mode.`);
    }

    if (!activeJob || activeJob.jobId !== payload.jobId) {
      throw new Error(`Stale or unknown job ${payload.jobId}.`);
    }

    return upstream.submit(payload.jobId, payload.extranonce2, payload.ntime, payload.nonceHex);
  }

  close() {
    this.started = false;
    this.monitorTimer && clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.userUpstream?.close();
    this.devUpstream?.close();
    this.userUpstream = null;
    this.devUpstream = null;
    this.lastUserJob = null;
    this.lastDevJob = null;
    this.emit("closed");
  }

  private attachUpstream(upstream: StratumSession, mode: MiningMode) {
    upstream.on("log", (message: string) => {
      this.emit("log", `${mode.toUpperCase()} ${message}`);
    });

    upstream.on("difficulty", (value: number) => {
      this.emit("difficulty", { mode, value });
    });

    upstream.on("job", (job: BrowserJob) => {
      if (mode === "user") {
        this.lastUserJob = job;
      } else {
        this.lastDevJob = job;
      }

      if (this.mode === mode) {
        this.emit("job", { ...job, mode });
      }
    });

    upstream.on("shareResult", (x: any) => {
      const accepted = Boolean(x.accepted);
      if (mode === "user") {
        if (accepted) this.userAccepted += 1; else this.userRejected += 1;
      } else {
        if (accepted) this.devAccepted += 1; else this.devRejected += 1;
      }

      this.emit("shareResult", { ...x, mode, accepted });
    });

    upstream.on("error", (error: Error) => {
      this.emit("error", { mode, error });
    });

    upstream.on("close", () => {
      this.emit("upstream_closed", { mode });
    });
  }

  private refreshMode() {
    if (!this.started) return;
    const elapsed = Date.now() - this.startedAt;
    const nextMode = getModeForElapsed(elapsed);
    if (nextMode !== this.mode) {
      this.mode = nextMode;
      this.emit("mode", {
        mode: this.mode,
        countdownMs: getModeCountdownMs(elapsed)
      });

      const activeJob = nextMode === "user" ? this.lastUserJob : this.lastDevJob;
      if (activeJob) {
        this.emit("job", { ...activeJob, mode: nextMode });
      }
    } else {
      this.emit("mode", {
        mode: this.mode,
        countdownMs: getModeCountdownMs(elapsed)
      });
    }
  }
}
