import net from "node:net";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { buildBrowserJob, type NotifyJob, type BrowserJob } from "./work.js";

type Rpc = { id?: number | null; method?: string; params?: any[]; result?: any; error?: any };
type StratumIdentity = { wallet: string; password: string };

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class StratumSession extends EventEmitter {
  private socket: net.Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private manualClose = false;
  private fatalAuthFailure = false;
  private buf = "";
  private nextId = 1;
  private subscribeId = 0;
  private authorizeId = 0;
  private identity: StratumIdentity;
  private authorized = false;

  private extranonce1 = "";
  private extranonce2Size = 0;
  private extranonce2Counter = 0n;
  private difficulty = 1;

  constructor(identity: StratumIdentity) {
    super();
    this.identity = identity;
  }

  connect() {
    this.manualClose = false;
    this.fatalAuthFailure = false;
    if (this.socket || this.reconnectTimer) return;
    this.openSocket();
  }

  close() {
    this.manualClose = true;
    this.authorized = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  submit(jobId: string, extranonce2: string, ntime: string, nonceHex: string) {
    if (!this.authorized || !this.socket?.writable) {
      throw new Error("Upstream is not authorized/connected");
    }
    if (!jobId || jobId.length > 128 || /[\x00-\x1F\x7F]/.test(jobId)) {
      throw new Error("Invalid job id");
    }
    if (!/^[0-9a-fA-F]{8}$/.test(ntime)) throw new Error("ntime must be 4-byte hex");
    if (!/^[0-9a-fA-F]{8}$/.test(nonceHex)) throw new Error("nonce must be 4-byte hex");
    if (!Number.isInteger(this.extranonce2Size) || this.extranonce2Size < 1) {
      throw new Error("Upstream extranonce2 size is not known");
    }
    const expectedExtranonce2Length = this.extranonce2Size * 2;
    if (!new RegExp(`^[0-9a-fA-F]{${expectedExtranonce2Length}}$`).test(extranonce2)) {
      throw new Error(`extranonce2 must be ${this.extranonce2Size} bytes of hex`);
    }

    const id = this.send("mining.submit", [
      this.identity.wallet,
      jobId,
      extranonce2.toLowerCase(),
      ntime.toLowerCase(),
      nonceHex.toLowerCase()
    ]);
    this.emit("submitted", { id, jobId, nonceHex });
    return id;
  }

  private openSocket() {
    if (this.manualClose || this.fatalAuthFailure || this.socket) return;

    this.resetConnectionState();
    const socket = new net.Socket();
    this.socket = socket;
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(180_000);

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("timeout", () => {
      this.emit("log", "UPSTREAM timeout; reconnecting");
      socket.destroy();
    });
    socket.on("error", (error) => {
      this.emit("error", error);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.authorized = false;
      this.emit("close");
      this.scheduleReconnect();
    });

    socket.connect(config.poolPort, config.poolHost, () => {
      this.emit("log", `CONNECTED ${config.poolHost}:${config.poolPort}`);
      this.subscribeId = this.send("mining.subscribe", ["Minewhile/0.2"]);
    });
  }

  private resetConnectionState() {
    this.buf = "";
    this.subscribeId = 0;
    this.authorizeId = 0;
    this.authorized = false;
    this.extranonce1 = "";
    this.extranonce2Size = 0;
    this.extranonce2Counter = 0n;
    this.difficulty = 1;
  }

  private scheduleReconnect() {
    if (this.manualClose || this.fatalAuthFailure || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[index];
    this.reconnectAttempt += 1;
    this.emit("log", `RECONNECTING in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private onData(chunk: Buffer) {
    this.buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private send(method: string, params: any[]) {
    if (!this.socket?.writable) throw new Error("Upstream socket is not writable");
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params }) + "\n";
    if (config.debug) this.emit("debug", `>> ${msg.trim()}`);
    this.socket.write(msg);
    return id;
  }

  private onLine(line: string) {
    if (config.debug) this.emit("debug", `<< ${line}`);
    let m: Rpc;
    try {
      m = JSON.parse(line);
    } catch {
      this.emit("log", "BAD JSON from upstream");
      return;
    }

    if (m.id === this.subscribeId && Array.isArray(m.result)) {
      this.extranonce1 = String(m.result[1] ?? "");
      this.extranonce2Size = Number(m.result[2] ?? 0);
      if (!this.extranonce1 || !Number.isInteger(this.extranonce2Size) || this.extranonce2Size < 1 || this.extranonce2Size > 16) {
        this.emit("error", new Error("Invalid subscribe response from upstream"));
        this.socket?.destroy();
        return;
      }
      this.emit("log", `SUBSCRIBED xnonce2=${this.extranonce2Size}B`);
      this.authorizeId = this.send("mining.authorize", [this.identity.wallet, this.identity.password]);
      return;
    }

    if (m.id === this.authorizeId) {
      if (m.result !== true) {
        this.fatalAuthFailure = true;
        this.emit("error", new Error(`Authorization rejected: ${JSON.stringify(m.error)}`));
        this.socket?.destroy();
      } else {
        this.authorized = true;
        this.reconnectAttempt = 0;
        this.emit("log", "AUTHORIZED");
      }
      return;
    }

    if (m.method === "mining.set_extranonce") {
      const nextExtranonce1 = String(m.params?.[0] ?? "");
      const nextSize = Number(m.params?.[1] ?? 0);
      if (nextExtranonce1 && Number.isInteger(nextSize) && nextSize > 0 && nextSize <= 16) {
        this.extranonce1 = nextExtranonce1;
        this.extranonce2Size = nextSize;
        this.extranonce2Counter = 0n;
        this.emit("log", `EXTRANONCE updated xnonce2=${nextSize}B`);
      }
      return;
    }

    if (m.method === "mining.set_difficulty") {
      const nextDifficulty = Number(m.params?.[0]);
      if (!Number.isFinite(nextDifficulty) || nextDifficulty <= 0) {
        this.emit("error", new Error(`Invalid difficulty: ${String(m.params?.[0])}`));
        return;
      }
      this.difficulty = nextDifficulty;
      this.emit("difficulty", this.difficulty);
      if (config.debug) this.emit("debug", `DIFFICULTY ${this.difficulty}`);
      return;
    }

    if (m.method === "mining.notify") {
      const p = m.params ?? [];
      if (p.length < 9) {
        this.emit("error", new Error("Unsupported/non-standard mining.notify"));
        return;
      }
      const job: NotifyJob = {
        jobId: String(p[0]),
        prevhash: String(p[1]),
        coinb1: String(p[2]),
        coinb2: String(p[3]),
        merkleBranch: Array.isArray(p[4]) ? p[4].map(String) : [],
        version: String(p[5]),
        nbits: String(p[6]),
        ntime: String(p[7]),
        cleanJobs: Boolean(p[8])
      };

      if (!this.extranonce1 || !this.extranonce2Size) {
        this.emit("log", "Ignoring notify before subscribe is complete");
        return;
      }

      this.extranonce2Counter += 1n;
      try {
        const browserJob = buildBrowserJob(
          job,
          this.extranonce1,
          this.extranonce2Size,
          this.extranonce2Counter,
          this.difficulty
        );
        this.emit("job", browserJob);
        this.emit("log", `JOB ${job.jobId}`);
        if (config.debug) this.emit("debug", `JOB ${job.jobId} header76=${browserJob.header76Hex}`);
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    if (typeof m.id === "number" && m.id !== this.subscribeId && m.id !== this.authorizeId) {
      const accepted = m.result === true;
      this.emit("shareResult", { id: m.id, accepted, error: m.error ?? null });
      if (config.debug) {
        this.emit("debug", accepted ? `SHARE ACCEPTED id=${m.id}` : `SHARE REJECTED id=${m.id} ${JSON.stringify(m.error)}`);
      }
    }
  }
}
