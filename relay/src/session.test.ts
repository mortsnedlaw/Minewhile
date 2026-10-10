import test from "node:test";
import assert from "node:assert/strict";

import {
  DEV_MODE_DURATION_MS,
  MODE_CYCLE_MS,
  USER_MODE_DURATION_MS,
  getModeAt,
  getModeCountdownMsAt,
  validateStartRequest
} from "./session.js";
import {
  buildBrowserJob,
  compareUint256LE,
  difficultyToTargetLE,
  sha256d,
  type NotifyJob
} from "./work.js";
import { SlidingWindowRateLimiter } from "./rateLimit.js";
import { getNextWorkerNonce, getWorkerNonceRange, getWorkerNonceStart } from "../../web/src/nonce.js";

test("difficulty to target conversion produces a valid 32-byte target", () => {
  const target = difficultyToTargetLE(1);
  assert.equal(target.length, 32);
  assert.ok(target.some((byte) => byte !== 0));
});

test("uint256 comparison is little-endian, not lexicographic byte order", () => {
  const a = Buffer.alloc(32);
  const b = Buffer.alloc(32);
  a[0] = 0xff; // 255
  b[1] = 0x01; // 256
  assert.equal(compareUint256LE(a, b), -1);
  assert.equal(compareUint256LE(b, a), 1);
  assert.equal(compareUint256LE(a, Buffer.from(a)), 0);
  assert.equal(sha256d(Buffer.from([1, 2, 3, 4])).length, 32);
});

test("global fee schedule is 9 minutes user + 1 minute dev and reconnect-independent", () => {
  const cycleStart = MODE_CYCLE_MS * 12345;
  assert.equal(USER_MODE_DURATION_MS, 9 * 60 * 1000);
  assert.equal(DEV_MODE_DURATION_MS, 60 * 1000);
  assert.equal(getModeAt(cycleStart), "user");
  assert.equal(getModeAt(cycleStart + USER_MODE_DURATION_MS - 1), "user");
  assert.equal(getModeAt(cycleStart + USER_MODE_DURATION_MS), "dev");
  assert.equal(getModeAt(cycleStart + MODE_CYCLE_MS), "user");
  assert.equal(getModeCountdownMsAt(cycleStart), USER_MODE_DURATION_MS);
  assert.equal(getModeCountdownMsAt(cycleStart + USER_MODE_DURATION_MS), DEV_MODE_DURATION_MS);
});

test("start validation rejects unsupported currencies and malformed data", () => {
  assert.equal(validateStartRequest({ type: "start", payoutCurrency: "DOGE", payoutAddress: "abc", workerCount: 2 }).valid, true);
  assert.equal(validateStartRequest({ type: "start", payoutCurrency: "NENG", payoutAddress: "abc", workerCount: 2 }).valid, true);
  assert.equal(validateStartRequest({ type: "start", payoutCurrency: "NOTACOIN", payoutAddress: "abc", workerCount: 2 }).valid, false);
  assert.equal(validateStartRequest({ type: "start", payoutCurrency: "LTC", payoutAddress: "bad\nvalue", workerCount: 2 }).valid, false);
  assert.equal(validateStartRequest({ type: "start", payoutCurrency: "LTC", payoutAddress: "abc", workerCount: 0 }).valid, false);

  const valid = validateStartRequest({ type: "start", payoutCurrency: "ltc", payoutAddress: "LdR7V6R1NwN9b7jFG2kK2KSqD", workerCount: 2 });
  assert.equal(valid.valid, true);
  if (valid.valid) assert.equal(valid.value.payoutCurrency, "LTC");
});

test("nonce ranges are disjoint for arbitrary worker counts", () => {
  const workerCount = 6;
  const ranges = Array.from({ length: workerCount }, (_, index) => getWorkerNonceRange(index, workerCount));
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[ranges.length - 1].end, 0xffffffff);

  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i - 1].end + 1, ranges[i].start);
  }

  const seed = 0x1234abcd;
  for (let index = 0; index < workerCount; index++) {
    const range = ranges[index];
    const start = getWorkerNonceStart(seed, index, workerCount);
    assert.ok(start >= range.start && start <= range.end);
    const next = getNextWorkerNonce(range.end, index, workerCount);
    assert.equal(next, range.start);
  }
});

test("captured Zpool v0.1 job still builds the exact known header76", () => {
  const job: NotifyJob = {
    jobId: "1bd26",
    prevhash: "c2ecd4da584d7e2916c9e54764f77b8ad9bca37c24e12d9a009fa1010000ad56",
    coinb1: "03000500010000000000000000000000000000000000000000000000000000000000000000ffffffff220376511b04cc00c86a08",
    coinb2: "2f7a706f6f6c2e63612fa842b8a62f00000000000200e1f505000000001976a914a47ede0a269db26621d1132ff1c4f0dccaa105e688ac00a3e111000000001976a91468bb85d17e8aae0347d9a897e0f9347ac46aea7388ac0000000026010076511b000a674c4f534ae3a1494ffa133c70e25f64668895d333d0819b0c3c661033d2a1",
    merkleBranch: [],
    version: "20000000",
    nbits: "1e353ea0",
    ntime: "6ac800cc",
    cleanJobs: true
  };

  const built = buildBrowserJob(job, "80007844", 4, 1n, 0.1);
  assert.equal(built.extranonce2, "00000001");
  assert.equal(
    built.header76Hex,
    "00000020dad4ecc2297e4d5847e5c9168a7bf7647ca3bcd99a2de12401a19f0056ad00001493e6f664d746ce1953b3e55fdc35a7000dcab6995e1d46f6fc659f62737a73cc00c86aa03e351e"
  );
});

test("sliding-window limiter blocks excess requests and recovers after the window", () => {
  const limiter = new SlidingWindowRateLimiter(2, 1000);
  assert.equal(limiter.allow(1000), true);
  assert.equal(limiter.allow(1200), true);
  assert.equal(limiter.allow(1300), false);
  assert.equal(limiter.allow(2001), true);
});
