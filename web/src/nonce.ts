export function getWorkerNonceStart(seed: number, workerIndex: number, workerCount: number): number {
  if (!Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new Error("workerIndex must be a non-negative integer");
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error("workerCount must be a positive integer");
  }
  if (workerIndex >= workerCount) {
    throw new Error("workerIndex must be less than workerCount");
  }
  return ((seed >>> 0) + (workerIndex >>> 0)) >>> 0;
}

export function getNonceStride(workerCount: number): number {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error("workerCount must be a positive integer");
  }
  return workerCount >>> 0;
}
