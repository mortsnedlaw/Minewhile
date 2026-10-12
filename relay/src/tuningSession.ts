import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { StratumSession } from "./stratum.js";
import type { AlgorithmEndpoint } from "./algoScheduler.js";
import type { BrowserJob } from "./work.js";
import { validateYespowerShare } from "./validator.js";
import { isAlgorithmVerified, markAlgorithmVerified, listVerifiedAlgorithms } from "./algorithmVerification.js";

export const TUNE_TARGET_ACCEPTED_SHARES = 2;
export const TUNE_MIN_HASHING_MS = 12_000;
export const TUNE_MAX_HASHING_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 15_000;

type TuneJob = BrowserJob & {
  mode: "dev";
  generationId: number;
  tuning: true;
  tuneId: string;
};

export class TuningSession extends EventEmitter {
  readonly id = randomUUID();
  private index = -1;
  private upstream: StratumSession | null = null;
  private activeJob: TuneJob | null = null;
  private generationId = 0;
  private stepTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private recentShares = new Set<string>();
  private recentQueue: string[] = [];
  private accepted: Record<string, number> = {};
  private rejected: Record<string, number> = {};
  private hashingStartedAt = 0;

  constructor(private readonly plan: AlgorithmEndpoint[]) {
    super();
  }

  start() {
    if (this.closed) throw new Error("Tune session is closed.");
    this.emit("plan", {
      tuneId: this.id,
      algorithms: this.plan.map((x) => x.id),
      targetAcceptedShares: TUNE_TARGET_ACCEPTED_SHARES,
      maxHashingMsPerAlgorithm: TUNE_MAX_HASHING_MS
    });
    this.startStep(0);
  }

  async submit(payload: {
    jobId: string;
    extranonce2: string;
    ntime: string;
    nonceHex: string;
    generationId: number;
    tuneId: string;
  }) {
    if (this.closed || payload.tuneId !== this.id) throw new Error("Tune session mismatch.");
    const job = this.activeJob;
    if (!job || job.generationId !== payload.generationId || job.jobId !== payload.jobId) {
      throw new Error("Stale tuning job.");
    }
    if (payload.extranonce2.toLowerCase() !== job.extranonce2.toLowerCase()) throw new Error("Tuning extranonce2 mismatch.");
    if (payload.ntime.toLowerCase() !== job.ntime.toLowerCase()) throw new Error("Tuning ntime mismatch.");
    if (!/^[0-9a-fA-F]{8}$/.test(payload.nonceHex)) throw new Error("nonce must be 4-byte hex");

    const key = [job.algorithmId, payload.generationId, payload.jobId, payload.extranonce2, payload.ntime, payload.nonceHex].join(":").toLowerCase();
    if (this.recentShares.has(key)) throw new Error("Duplicate tuning share.");
    this.recentShares.add(key);
    this.recentQueue.push(key);
    if (this.recentQueue.length > 1024) {
      const oldest = this.recentQueue.shift();
      if (oldest) this.recentShares.delete(oldest);
    }

    const valid = await validateYespowerShare(job.algorithmId, job.header76Hex, job.targetHex, payload.nonceHex);
    if (this.closed || this.activeJob?.generationId !== payload.generationId || this.activeJob?.algorithmId !== job.algorithmId) {
      throw new Error("Stale tuning job after local validation.");
    }
    if (!valid) {
      this.rejected[job.algorithmId] = (this.rejected[job.algorithmId] ?? 0) + 1;
      this.emit("shareResult", {
        mode: "dev",
        tuning: true,
        tuneId: this.id,
        algorithmId: job.algorithmId,
        accepted: false,
        local: true,
        error: "Invalid proof of work."
      });
      return null;
    }
    if (!this.upstream) throw new Error("No tuning upstream.");
    return this.upstream.submit(payload.jobId, payload.extranonce2, payload.ntime, payload.nonceHex);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.stepTimer) clearTimeout(this.stepTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.stepTimer = null;
    this.connectTimer = null;
    this.upstream?.close();
    this.upstream = null;
    this.activeJob = null;
  }

  private startStep(index: number) {
    if (this.closed) return;
    if (this.stepTimer) clearTimeout(this.stepTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.upstream?.close();
    this.upstream = null;
    this.activeJob = null;
    this.hashingStartedAt = 0;

    if (index >= this.plan.length) {
      const result = {
        tuneId: this.id,
        accepted: this.accepted,
        rejected: this.rejected,
        verifiedAlgorithms: listVerifiedAlgorithms()
      };
      this.close();
      this.emit("complete", result);
      return;
    }

    this.index = index;
    const endpoint = this.plan[index];
    this.emit("step", {
      tuneId: this.id,
      index,
      total: this.plan.length,
      algorithmId: endpoint.id,
      targetAcceptedShares: TUNE_TARGET_ACCEPTED_SHARES,
      maxHashingMs: TUNE_MAX_HASHING_MS
    });

    const upstream = new StratumSession({
      wallet: config.devWallet,
      password: `c=${config.devCurrency}`,
      endpoint
    });
    this.upstream = upstream;
    let hashingStarted = false;

    const startHashingTimer = () => {
      if (hashingStarted || this.closed || this.upstream !== upstream) return;
      hashingStarted = true;
      this.hashingStartedAt = Date.now();
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.stepTimer = setTimeout(() => this.startStep(index + 1), TUNE_MAX_HASHING_MS);
    };

    upstream.on("log", (message: string) => this.emit("log", `TUNE ${endpoint.id} ${message}`));
    upstream.on("state", (payload: any) => this.emit("health", { mode: "dev", tuning: true, ...payload }));
    upstream.on("difficulty", (value: number) => this.emit("difficulty", { mode: "dev", tuning: true, algorithmId: endpoint.id, value }));
    upstream.on("error", (error: Error) => this.emit("error", error));

    upstream.on("job", (job: BrowserJob) => {
      if (this.closed || this.upstream !== upstream) return;
      startHashingTimer();
      this.generationId += 1;
      this.activeJob = {
        ...job,
        mode: "dev",
        generationId: this.generationId,
        tuning: true,
        tuneId: this.id
      };
      this.emit("job", this.activeJob);
    });

    upstream.on("shareResult", (x: any) => {
      if (this.closed || this.upstream !== upstream || this.index !== index) return;
      const accepted = Boolean(x.accepted);
      if (accepted) {
        this.accepted[endpoint.id] = (this.accepted[endpoint.id] ?? 0) + 1;
        const count = this.accepted[endpoint.id];
        if (endpoint.id !== "yespower" && count >= TUNE_TARGET_ACCEPTED_SHARES && !isAlgorithmVerified(endpoint.id)) {
          markAlgorithmVerified(endpoint.id);
          markAlgorithmVerified(endpoint.id);
        }
      } else {
        this.rejected[endpoint.id] = (this.rejected[endpoint.id] ?? 0) + 1;
      }
      this.emit("shareResult", {
        ...x,
        mode: "dev",
        tuning: true,
        tuneId: this.id,
        algorithmId: endpoint.id,
        accepted,
        acceptedForAlgorithm: this.accepted[endpoint.id] ?? 0,
        targetAcceptedShares: TUNE_TARGET_ACCEPTED_SHARES
      });
      if (accepted && (this.accepted[endpoint.id] ?? 0) >= TUNE_TARGET_ACCEPTED_SHARES) {
        const elapsed = this.hashingStartedAt ? Date.now() - this.hashingStartedAt : TUNE_MIN_HASHING_MS;
        if (this.stepTimer) clearTimeout(this.stepTimer);
        this.stepTimer = setTimeout(() => this.startStep(index + 1), Math.max(0, TUNE_MIN_HASHING_MS - elapsed));
      }
    });

    this.connectTimer = setTimeout(() => {
      if (hashingStarted || this.closed || this.upstream !== upstream) return;
      this.emit("log", `TUNE ${endpoint.id} no job received; moving on`);
      this.startStep(index + 1);
    }, CONNECT_TIMEOUT_MS);

    upstream.connect();
  }
}
