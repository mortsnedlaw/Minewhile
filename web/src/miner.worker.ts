import { getWorkerNonceStart } from "./nonce.js";

type Job = {
  jobId: string;
  header76Hex: string;
  targetHex: string;
  extranonce2: string;
  ntime: string;
};

type WorkerJob = {
  type: "job";
  job: Job;
  workerIndex: number;
  workerCount: number;
  nonceStart: number;
};

let currentToken = 0;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("odd hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function le256LTE(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 31; i >= 0; i--) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return true;
}

let mod: any;

async function loadWasm() {
  const factory = (await import("./generated/yespower.mjs")).default;
  mod = await factory();
  if (mod._yp_init() !== 0) throw new Error("yp_init failed");
  postMessage({ type: "ready" });
}

const ready = loadWasm().catch((e) => postMessage({ type: "error", message: String(e) }));

async function mine(job: Job, workerIndex: number, workerCount: number, nonceStart: number, token: number) {
  await ready;
  if (!mod) return;

  const prefix = hexToBytes(job.header76Hex);
  const target = hexToBytes(job.targetHex);
  if (prefix.length !== 76 || target.length !== 32) throw new Error("bad job size");

  const inPtr = mod._malloc(80);
  const outPtr = mod._malloc(32);
  let nonce = getWorkerNonceStart(nonceStart, workerIndex, workerCount);
  let hashes = 0;
  let sampleStart = performance.now();

  try {
    while (token === currentToken) {
      const header = new Uint8Array(80);
      header.set(prefix, 0);

      header[76] = nonce & 0xff;
      header[77] = (nonce >>> 8) & 0xff;
      header[78] = (nonce >>> 16) & 0xff;
      header[79] = (nonce >>> 24) & 0xff;

      mod.HEAPU8.set(header, inPtr);
      const rc = mod._yp_hash(inPtr, 80, outPtr);
      if (rc !== 0) throw new Error(`yp_hash rc=${rc}`);

      const hash = new Uint8Array(mod.HEAPU8.slice(outPtr, outPtr + 32));
      hashes++;

      if (le256LTE(hash, target)) {
        const nonceHex = nonce.toString(16).padStart(8, "0");
        postMessage({
          type: "share",
          jobId: job.jobId,
          extranonce2: job.extranonce2,
          ntime: job.ntime,
          nonceHex,
          hashHex: bytesToHex(hash),
          workerIndex
        });
      }

      nonce = (nonce + workerCount) >>> 0;

      if ((hashes & 31) === 0) {
        const now = performance.now();
        if (now - sampleStart >= 2000) {
          postMessage({
            type: "hashrate",
            workerIndex,
            hps: (hashes * 1000) / (now - sampleStart)
          });
          hashes = 0;
          sampleStart = now;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    mod._free(inPtr);
    mod._free(outPtr);
  }
}

self.onmessage = (ev: MessageEvent<WorkerJob>) => {
  if (ev.data?.type === "job") {
    currentToken += 1;
    const token = currentToken;
    const { job, workerIndex, workerCount, nonceStart } = ev.data;
    mine(job, workerIndex, workerCount, nonceStart, token).catch((e) =>
      postMessage({ type: "error", message: String(e?.stack ?? e) })
    );
  }
};
