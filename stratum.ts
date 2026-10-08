import net from "node:net";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { buildBrowserJob, NotifyJob, BrowserJob } from "./work.js";

type Rpc = { id?: number | null; method?: string; params?: any[]; result?: any; error?: any };

export class StratumSession extends EventEmitter {
  private socket = new net.Socket();
  private buf = "";
  private nextId = 1;
  private subscribeId = 0;
  private authorizeId = 0;

  private extranonce1 = "";
  private extranonce2Size = 0;
  private extranonce2Counter = 0n;
  private difficulty = 1;
  private lastBrowserJob: BrowserJob | null = null;

  connect() {
    this.socket.setKeepAlive(true, 30_000);

    this.socket.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) this.onLine(line);
      }
    });

    this.socket.on("error", (e) => this.emit("error", e));
    this.socket.on("close", () => this.emit("close"));

    this.socket.connect(config.poolPort, config.poolHost, () => {
      this.emit("log", `CONNECTED ${config.poolHost}:${config.poolPort}`);
      this.subscribeId = this.send("mining.subscribe", ["BrowserYesPower/0.1"]);
    });
  }

  close() {
    this.socket.destroy();
  }

  submit(jobId: string, extranonce2: string, ntime: string, nonceHex: string) {
    if (!/^[0-9a-fA-F]{8}$/.test(nonceHex)) throw new Error("nonce must be 4-byte hex");
    const id = this.send("mining.submit", [
      config.wallet,
      jobId,
      extranonce2,
      ntime,
      nonceHex.toLowerCase()
    ]);
    this.emit("submitted", { id, jobId, nonceHex });
    return id;
  }

  private send(method: string, params: any[]) {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params }) + "\n";
    if (config.debug) this.emit("log", `>> ${msg.trim()}`);
    this.socket.write(msg);
    return id;
  }

  private onLine(line: string) {
    if (config.debug) this.emit("log", `<< ${line}`);
    let m: Rpc;
    try { m = JSON.parse(line); }
    catch { this.emit("log", `BAD JSON: ${line}`); return; }

    // subscribe response: result = [subscriptions, extranonce1, extranonce2_size]
    if (m.id === this.subscribeId && Array.isArray(m.result)) {
      this.extranonce1 = String(m.result[1]);
      this.extranonce2Size = Number(m.result[2]);
      this.emit("log", `SUBSCRIBED extranonce1=${this.extranonce1} xnonce2=${this.extranonce2Size}B`);
      this.authorizeId = this.send("mining.authorize", [config.wallet, config.password]);
      return;
    }

    if (m.id === this.authorizeId) {
      if (m.result !== true) {
        this.emit("error", new Error(`Authorization rejected: ${JSON.stringify(m.error)}`));
      } else {
        this.emit("log", "AUTHORIZED");
      }
      return;
    }

    if (m.method === "mining.set_difficulty") {
      this.difficulty = Number(m.params?.[0]);
      this.emit("difficulty", this.difficulty);
      this.emit("log", `DIFFICULTY ${this.difficulty}`);
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

      this.extranonce2Counter++;
      const browserJob = buildBrowserJob(
        job,
        this.extranonce1,
        this.extranonce2Size,
        this.extranonce2Counter,
        this.difficulty
      );
      this.lastBrowserJob = browserJob;
      this.emit("job", browserJob);
      this.emit("log", `JOB ${job.jobId} header76=${browserJob.header76Hex}`);
      return;
    }

    // Any other response with an id after authorization is likely submit result.
    if (typeof m.id === "number" && m.id !== this.subscribeId && m.id !== this.authorizeId) {
      const accepted = m.result === true;
      this.emit("shareResult", { id: m.id, accepted, error: m.error ?? null });
      this.emit("log", accepted ? `SHARE ACCEPTED id=${m.id}` : `SHARE REJECTED id=${m.id} ${JSON.stringify(m.error)}`);
    }
  }
}
