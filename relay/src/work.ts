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
  const a = crypto.createHash("sha256").update(data).digest();
  return crypto.createHash("sha256").update(a).digest();
}

function reverse4(hex8: string): Buffer {
  const b = Buffer.from(hex8, "hex");
  if (b.length !== 4) throw new Error(`Expected 4 bytes, got ${b.length}`);
  return Buffer.from(b).reverse();
}

function reverseEachWord32(hex64: string): Buffer {
  const b = Buffer.from(hex64, "hex");
  if (b.length !== 32) throw new Error(`Expected 32-byte prevhash`);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 4) {
    out[i] = b[i + 3];
    out[i + 1] = b[i + 2];
    out[i + 2] = b[i + 1];
    out[i + 3] = b[i];
  }
  return out;
}

/*
 * cpuminer uses scrypt_set_target() for YesPower:
 *   work_set_target(job_diff / 65536)
 *
 * Therefore the effective diff-1 target is Bitcoin diff1 * 65536.
 * We compute with scaled integer arithmetic to avoid JS floating precision
 * being used directly on a 256-bit integer.
 */
const BITCOIN_DIFF1 =
  BigInt("0x00000000ffff0000000000000000000000000000000000000000000000000000");
const SCRYPT_DIFF1 = BITCOIN_DIFF1 * 65536n;

export function difficultyToTargetLE(diff: number): Buffer {
  if (!Number.isFinite(diff) || diff <= 0) throw new Error(`Bad difficulty: ${diff}`);

  // Preserve useful precision without floating-point BigInt conversion.
  const SCALE = 1_000_000_000n;
  const d = BigInt(Math.max(1, Math.round(diff * Number(SCALE))));
  let target = (SCRYPT_DIFF1 * SCALE) / d;
  const max256 = (1n << 256n) - 1n;
  if (target > max256) target = max256;

  let be = target.toString(16).padStart(64, "0");
  return Buffer.from(be, "hex").reverse(); // hash comparison uses LE integer form
}

export function buildBrowserJob(
  job: NotifyJob,
  extranonce1: string,
  extranonce2Size: number,
  extranonce2Counter: bigint,
  difficulty: number
): BrowserJob {
  const extranonce2 = extranonce2Counter
    .toString(16)
    .padStart(extranonce2Size * 2, "0")
    .slice(-extranonce2Size * 2);

  const coinbase = Buffer.from(
    job.coinb1 + extranonce1 + extranonce2 + job.coinb2,
    "hex"
  );

  let merkle = sha256d(coinbase);
  for (const branchHex of job.merkleBranch) {
    merkle = sha256d(Buffer.concat([merkle, Buffer.from(branchHex, "hex")]));
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
    ntime: job.ntime
  };
}
