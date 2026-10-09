export type NonceRange = {
  start: number;
  end: number;
  size: number;
};

const NONCE_SPACE = 0x1_0000_0000; // 2^32

export function getWorkerNonceRange(workerIndex: number, workerCount: number): NonceRange {
  if (!Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new Error("workerIndex must be a non-negative integer");
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error("workerCount must be a positive integer");
  }
  if (workerIndex >= workerCount) {
    throw new Error("workerIndex must be less than workerCount");
  }

  const start = Math.floor((NONCE_SPACE * workerIndex) / workerCount);
  const endExclusive = Math.floor((NONCE_SPACE * (workerIndex + 1)) / workerCount);
  return {
    start,
    end: endExclusive - 1,
    size: endExclusive - start
  };
}

export function getWorkerNonceStart(seed: number, workerIndex: number, workerCount: number): number {
  const range = getWorkerNonceRange(workerIndex, workerCount);
  const offset = (seed >>> 0) % range.size;
  return range.start + offset;
}

export function getNextWorkerNonce(nonce: number, workerIndex: number, workerCount: number): number {
  const range = getWorkerNonceRange(workerIndex, workerCount);
  if (nonce < range.start || nonce > range.end) {
    throw new Error("nonce is outside the worker range");
  }
  return nonce >= range.end ? range.start : nonce + 1;
}
