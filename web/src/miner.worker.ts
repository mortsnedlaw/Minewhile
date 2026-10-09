import { getNextWorkerNonce, getWorkerNonceStart } from "./nonce.js";

type MiningMode = "user" | "dev";

type Job = {
  jobId: string;
  header76Hex: string;
  targetHex: string;
  extranonce2: string;
  ntime: string;
  mode: MiningMode;
  generationId: number;
};

type WorkerMessage =
  | {
      type: "job";
      job: Job;
      workerIndex: number;
      workerCount: number;
      nonceSeed: number;
    }
  | { type: "stop" };

let currentToken = 0;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("odd hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

// YesPower output and relay target are both compared as unsigned LE uint256 values.
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

const ready = loadWasm().catch((error) => {
  postMessage({ type: "error", message: String(error?.stack ?? error) });
  throw error;
});

async function mine(
  job: Job,
  workerIndex: number,
  workerCount: number,
  nonceSeed: number,
  token: number
) {
  await ready;
  if (!mod || token !== currentToken) return;

  const prefix = hexToBytes(job.header76Hex);
  const target = hexToBytes(job.targetHex);
  if (prefix.length !== 76 || target.length !== 32) throw new Error("bad job size");

  const inPtr = mod._malloc(80);
  const outPtr = mod._malloc(32);
  const header = new Uint8Array(80);
  header.set(prefix, 0);

  let nonce = getWorkerNonceStart(nonceSeed, workerIndex, workerCount);
  let hashes = 0;
  let sampleStart = performance.now();

  try {
    while (token === currentToken) {
      // Preserve the nonce byte order proven by the v0.1 accepted-share path:
      // native uint32 little-endian in the 80-byte YesPower header.
      header[76] = nonce & 0xff;
      header[77] = (nonce >>> 8) & 0xff;
      header[78] = (nonce >>> 16) & 0xff;
      header[79] = (nonce >>> 24) & 0xff;

      mod.HEAPU8.set(header, inPtr);
      const rc = mod._yp_hash(inPtr, 80, outPtr);
      if (rc !== 0) throw new Error(`yp_hash rc=${rc}`);

      const hash = new Uint8Array(mod.HEAPU8.slice(outPtr, outPtr + 32));
      hashes += 1;

      if (le256LTE(hash, target)) {
        postMessage({
          type: "share",
          jobId: job.jobId,
          extranonce2: job.extranonce2,
          ntime: job.ntime,
          nonceHex: nonce.toString(16).padStart(8, "0"),
          hashHex: bytesToHex(hash),
          workerIndex,
          mode: job.mode,
          generationId: job.generationId
        });
      }

      nonce = getNextWorkerNonce(nonce, workerIndex, workerCount);

      if ((hashes & 31) === 0) {
        const now = performance.now();
        if (now - sampleStart >= 2_000) {
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

self.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  if (ev.data?.type === "stop") {
    currentToken += 1;
    return;
  }

  if (ev.data?.type === "job") {
    currentToken += 1;
    const token = currentToken;
    const { job, workerIndex, workerCount, nonceSeed } = ev.data;
    mine(job, workerIndex, workerCount, nonceSeed, token).catch((error) =>
      postMessage({ type: "error", workerIndex, message: String(error?.stack ?? error) })
    );
  }
};
