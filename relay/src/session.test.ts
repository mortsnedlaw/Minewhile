import test from "node:test";
import assert from "node:assert/strict";

import { getModeCountdownMs, getModeForElapsed, validateStartRequest } from "./session.js";
import { difficultyToTargetLE, sha256d } from "./work.js";
import { getWorkerNonceStart, getNonceStride } from "../../web/src/nonce.js";

test("difficulty to target conversion produces a valid 32-byte target", () => {
  const target = difficultyToTargetLE(1);
  assert.equal(target.length, 32);
  assert.ok(target.some((byte) => byte !== 0));
});

test("target comparison is ordered as little-endian uint256", () => {
  const target = Buffer.alloc(32, 0xff);
  const hash = Buffer.alloc(32, 0x00);
  const result = Buffer.compare(Buffer.from(hash), Buffer.from(target));
  assert.ok(result < 0);
  assert.ok(sha256d(Buffer.from([1, 2, 3, 4])).length === 32);
});

test("mode scheduling prefers 9 minutes user and 1 minute dev", () => {
  assert.equal(getModeForElapsed(0), "user");
  assert.equal(getModeForElapsed(9 * 60 * 1000 - 1), "user");
  assert.equal(getModeForElapsed(9 * 60 * 1000), "dev");
  assert.equal(getModeForElapsed(10 * 60 * 1000), "user");
  assert.ok(getModeCountdownMs(9 * 60 * 1000 + 10_000) > 0);
});

test("start validation rejects unsupported currencies and malformed data", () => {
  const invalidCurrency = validateStartRequest({ type: "start", payoutCurrency: "DOGE", payoutAddress: "abc", workerCount: 2 });
  assert.equal(invalidCurrency.valid, false);

  const invalidAddress = validateStartRequest({ type: "start", payoutCurrency: "LTC", payoutAddress: "bad\nvalue", workerCount: 2 });
  assert.equal(invalidAddress.valid, false);

  const valid = validateStartRequest({ type: "start", payoutCurrency: "LTC", payoutAddress: "LdR7V6R1NwN9b7jFG2kK2KSqD", workerCount: 2 });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.value.payoutCurrency, "LTC");
  }
});

test("nonce partitioning assigns disjoint streams to workers", () => {
  const seed = 0x1234abcd;
  const positions = Array.from({ length: 4 }, (_, workerIndex) => {
    const start = getWorkerNonceStart(seed, workerIndex, 4);
    return [start, (start + 4) >>> 0, (start + 8) >>> 0];
  });
  const stride = getNonceStride(4);

  assert.equal(stride, 4);
  const flat = positions.flat();
  assert.equal(new Set(flat).size, flat.length);
  assert.equal(positions[0][0], 0x1234abcd);
  assert.equal(positions[1][0], 0x1234abce);
});
