import crypto from "node:crypto";

export type NotifyJob = {
  jobId: string;
  prevhash: string;
  coinb1: string;
  coinb2: string;
  merkleBranch: string[];
  version: string;
  nbits: string;
  ntime: string;
  cleanJobs: boolean;
};

export type BrowserJob = {
  jobId: string;
  header76Hex: string;
  targetHex: string;       // 32-byte little-endian target, same comparison order as hash
  extranonce2: string;
  ntime: string;
};

export function sha256d(data: Buffer): Buffer {
  const first = crypto.createHash("sha256").update(data).digest();
  return crypto.createHash("sha256").update(first).digest();
}

function hexBuffer(hex: string, expectedBytes?: number, label = "hex value"): Buffer {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`Invalid ${label}`);
  }
  const value = Buffer.from(hex, "hex");
  if (expectedBytes !== undefined && value.length !== expectedBytes) {
    throw new Error(`Expected ${expectedBytes} bytes for ${label}, got ${value.length}`);
  }
  return value;
}

function reverse4(hex8: string): Buffer {
  return Buffer.from(hexBuffer(hex8, 4, "32-bit header field")).reverse();
}

function reverseEachWord32(hex64: string): Buffer {
  const bytes = hexBuffer(hex64, 32, "prevhash");
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 4) {
    out[i] = bytes[i + 3];
    out[i + 1] = bytes[i + 2];
    out[i + 2] = bytes[i + 1];
    out[i + 3] = bytes[i];
  }
  return out;
}

/*
 * cpuminer-opt's YesPower registration sets opt_target_factor = 65536.
 * That means Stratum diff is converted to an effective target using
 * Bitcoin diff-1 target * 65536. Keep this path stable: it is part of
 * Minewhile's accepted-share v0.1 behavior.
 */
const BITCOIN_DIFF1 =
  BigInt("0x00000000ffff0000000000000000000000000000000000000000000000000000");
const YESPOWER_DIFF1 = BITCOIN_DIFF1 * 65536n;

export function difficultyToTargetLE(diff: number): Buffer {
  if (!Number.isFinite(diff) || diff <= 0) throw new Error(`Bad difficulty: ${diff}`);

  const SCALE = 1_000_000_000n;
  const scaledDifficulty = BigInt(Math.max(1, Math.round(diff * Number(SCALE))));
  let target = (YESPOWER_DIFF1 * SCALE) / scaledDifficulty;
  const max256 = (1n << 256n) - 1n;
  if (target > max256) target = max256;

  const bigEndianHex = target.toString(16).padStart(64, "0");
  return Buffer.from(bigEndianHex, "hex").reverse();
}

export function compareUint256LE(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== 32 || b.length !== 32) throw new Error("uint256 values must be 32 bytes");
  for (let i = 31; i >= 0; i--) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export function buildBrowserJob(
  job: NotifyJob,
  extranonce1: string,
  extranonce2Size: number,
  extranonce2Counter: bigint,
  difficulty: number
): BrowserJob {
  if (!job.jobId || job.jobId.length > 128) throw new Error("Invalid job id");
  if (!Number.isInteger(extranonce2Size) || extranonce2Size < 1 || extranonce2Size > 16) {
    throw new Error(`Invalid extranonce2 size: ${extranonce2Size}`);
  }
  hexBuffer(extranonce1, undefined, "extranonce1");
  hexBuffer(job.coinb1, undefined, "coinb1");
  hexBuffer(job.coinb2, undefined, "coinb2");

  const extranonce2 = extranonce2Counter
    .toString(16)
    .padStart(extranonce2Size * 2, "0")
    .slice(-extranonce2Size * 2);

  const coinbase = hexBuffer(job.coinb1 + extranonce1 + extranonce2 + job.coinb2, undefined, "coinbase");

  let merkle = sha256d(coinbase);
  for (const branchHex of job.merkleBranch) {
    const branch = hexBuffer(branchHex, 32, "merkle branch");
    merkle = sha256d(Buffer.concat([merkle, branch]));
  }

  const header76 = Buffer.concat([
    reverse4(job.version),
    reverseEachWord32(job.prevhash),
    merkle,
    reverse4(job.ntime),
    reverse4(job.nbits)
  ]);

  if (header76.length !== 76) {
    throw new Error(`Header prefix length ${header76.length}, expected 76`);
  }

  return {
    jobId: job.jobId,
    header76Hex: header76.toString("hex"),
    targetHex: difficultyToTargetLE(difficulty).toString("hex"),
    extranonce2,
    ntime: job.ntime.toLowerCase()
  };
}
