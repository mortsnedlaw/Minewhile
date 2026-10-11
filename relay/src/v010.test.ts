import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOCATION_CYCLE_MS,
  USER_ALLOCATION_MS,
  BENEFICIARY_ALLOCATION_MS,
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

test("referral allocation is 90/5/5", () => {
  const start = ALLOCATION_CYCLE_MS * 123;

  assert.equal(getAllocationAt(start, true), "user");
  assert.equal(
    getAllocationAt(start + USER_ALLOCATION_MS - 1, true),
    "user"
  );

  assert.equal(
    getAllocationAt(start + USER_ALLOCATION_MS, true),
    "beneficiary"
  );

  assert.equal(
    getAllocationAt(
      start + USER_ALLOCATION_MS + BENEFICIARY_ALLOCATION_MS,
      true
    ),
    "operator"
  );

  assert.equal(
    getAllocationCountdownMsAt(start + USER_ALLOCATION_MS, true),
    BENEFICIARY_ALLOCATION_MS
  );
});

test("non-referral allocation remains 90/10", () => {
  const start = ALLOCATION_CYCLE_MS * 55;

  assert.equal(
    getAllocationAt(start + USER_ALLOCATION_MS, false),
    "operator"
  );
});

test("beneficiary credentials are anonymous and high entropy", () => {
  const id = generateBeneficiaryId();
  const secret = generateManagementSecret();

  assert.equal(isValidBeneficiaryId(id), true);
  assert.equal(secret.length > 30, true);
  assert.equal(hashManagementSecret(secret).length, 64);
});

test("yespower catalog preserves current algorithm and adds variants", () => {
  const current = getAlgorithm("yespower");

  assert.equal(current.N, 2048);
  assert.equal(current.r, 32);
  assert.equal(current.personalization, null);

  assert.equal(YESPOWER_ALGORITHMS.yespowertide.r, 8);
  assert.equal(YESPOWER_ALGORITHMS.yespowerr16.N, 4096);
  assert.equal(YESPOWER_ALGORITHMS.yespowerr16.r, 16);
  assert.equal(
    YESPOWER_ALGORITHMS.yespowerurx.personalization,
    "UraniumX"
  );

  assert.equal(isAlgorithmId("yespower"), true);
  assert.equal(isAlgorithmId("totally-fake"), false);
});


import {
  BENEFICIARY_MODE_DURATION_MS,
  MODE_CYCLE_MS as SESSION_CYCLE_MS,
  USER_MODE_DURATION_MS as SESSION_USER_MS,
  getModeAt as getSessionModeAt,
  getModeCountdownMsAt as getSessionModeCountdownMsAt
} from "./session.js";

test("session routing exposes beneficiary mode only for referred miners", () => {
  const start = SESSION_CYCLE_MS * 91;

  assert.equal(
    getSessionModeAt(start + SESSION_USER_MS, false),
    "dev"
  );

  assert.equal(
    getSessionModeAt(start + SESSION_USER_MS, true),
    "beneficiary"
  );

  assert.equal(
    getSessionModeCountdownMsAt(
      start + SESSION_USER_MS,
      true
    ),
    BENEFICIARY_MODE_DURATION_MS
  );

  assert.equal(
    getSessionModeAt(
      start +
        SESSION_USER_MS +
        BENEFICIARY_MODE_DURATION_MS,
      true
    ),
    "dev"
  );
});
