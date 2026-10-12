import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOCATION_CYCLE_MS,
  USER_ALLOCATION_MS,
  BENEFICIARY_ALLOCATION_MS,
  OPERATOR_ALLOCATION_MS,
  getAllocationAt,
  getAllocationCountdownMsAt
} from "./allocation.js";

import {
  generateBeneficiaryId,
  generateManagementSecret,
  hashManagementSecret,
  isValidBeneficiaryId
} from "./beneficiary.js";

import {
  YESPOWER_ALGORITHMS,
  getAlgorithm,
  isAlgorithmId
} from "./algorithms.js";

import {
  BENEFICIARY_MODE_DURATION_MS,
  MODE_CYCLE_MS as SESSION_CYCLE_MS,
  USER_MODE_DURATION_MS as SESSION_USER_MS,
  getModeAt as getSessionModeAt,
  getModeCountdownMsAt as getSessionModeCountdownMsAt
} from "./session.js";

import { rankAlgorithmCandidates } from "./algoScheduler.js";
import { TUNE_TARGET_ACCEPTED_SHARES, TUNE_MIN_HASHING_MS, TUNE_MAX_HASHING_MS } from "./tuningSession.js";

test("referral allocation is 95/3/2", () => {
  const start = ALLOCATION_CYCLE_MS * 123;
  assert.equal(USER_ALLOCATION_MS, 570_000);
  assert.equal(BENEFICIARY_ALLOCATION_MS, 18_000);
  assert.equal(OPERATOR_ALLOCATION_MS, 12_000);
  assert.equal(getAllocationAt(start, true), "user");
  assert.equal(getAllocationAt(start + USER_ALLOCATION_MS - 1, true), "user");
  assert.equal(getAllocationAt(start + USER_ALLOCATION_MS, true), "beneficiary");
  assert.equal(
    getAllocationAt(start + USER_ALLOCATION_MS + BENEFICIARY_ALLOCATION_MS, true),
    "operator"
  );
  assert.equal(
    getAllocationCountdownMsAt(start + USER_ALLOCATION_MS, true),
    BENEFICIARY_ALLOCATION_MS
  );
});

test("non-referral allocation is 95/5", () => {
  const start = ALLOCATION_CYCLE_MS * 55;
  assert.equal(getAllocationAt(start + USER_ALLOCATION_MS, false), "operator");
  assert.equal(ALLOCATION_CYCLE_MS - USER_ALLOCATION_MS, 30_000);
});

test("beneficiary credentials are anonymous and high entropy", () => {
  const id = generateBeneficiaryId();
  const secret = generateManagementSecret();
  assert.equal(isValidBeneficiaryId(id), true);
  assert.equal(secret.length > 30, true);
  assert.equal(hashManagementSecret(secret).length, 64);
});

test("yespower catalog preserves standard and variant parameters", () => {
  const current = getAlgorithm("yespower");
  assert.equal(current.N, 2048);
  assert.equal(current.r, 32);
  assert.equal(current.personalization, null);
  assert.equal(YESPOWER_ALGORITHMS.yespowertide.r, 8);
  assert.equal(YESPOWER_ALGORITHMS.yespowerr16.N, 4096);
  assert.equal(YESPOWER_ALGORITHMS.yespowerr16.r, 16);
  assert.equal(YESPOWER_ALGORITHMS.yespowerurx.personalization, "UraniumX");
  assert.equal(isAlgorithmId("yespower"), true);
  assert.equal(isAlgorithmId("totally-fake"), false);
});

test("session routing exposes 95/3/2 beneficiary window", () => {
  const start = SESSION_CYCLE_MS * 91;
  assert.equal(SESSION_USER_MS, 570_000);
  assert.equal(BENEFICIARY_MODE_DURATION_MS, 18_000);
  assert.equal(getSessionModeAt(start + SESSION_USER_MS, false), "dev");
  assert.equal(getSessionModeAt(start + SESSION_USER_MS, true), "beneficiary");
  assert.equal(
    getSessionModeCountdownMsAt(start + SESSION_USER_MS, true),
    BENEFICIARY_MODE_DURATION_MS
  );
  assert.equal(
    getSessionModeAt(start + SESSION_USER_MS + BENEFICIARY_MODE_DURATION_MS, true),
    "dev"
  );
});

test("scheduler ranks profitability using browser hashrate", () => {
  const status = {
    yespower: {
      name: "yespower",
      port: 6234,
      estimate_current: "1",
      estimate_last24h: "1",
      mbtc_mh_factor: "1",
      hashrate: 1000000
    },
    yespowerTIDE: {
      name: "yespowerTIDE",
      port: 6239,
      estimate_current: "2",
      estimate_last24h: "2",
      mbtc_mh_factor: "1",
      hashrate: 1000000
    }
  };
  const currencies = {
    A: { algo: "yespower", hashrate: 100000000 },
    B: { algo: "yespowerTIDE", hashrate: 100000000 }
  };
  const ranked = rankAlgorithmCandidates(
    status,
    currencies,
    { yespower: 100, yespowertide: 100 },
    1
  );
  assert.equal(ranked[0].id, "yespowertide");
  assert.equal(ranked[0].port, 6239);
  assert.ok(ranked[0].score > ranked[1].score);
});


test("tuning requires two accepted shares and remains bounded", () => {
  assert.equal(TUNE_TARGET_ACCEPTED_SHARES, 2);
  assert.ok(TUNE_MIN_HASHING_MS >= 10_000);
  assert.ok(TUNE_MAX_HASHING_MS <= 10 * 60_000);
});
