export const ALLOCATION_CYCLE_MS = 10 * 60 * 1000;
export const USER_ALLOCATION_MS = 9 * 60 * 1000 + 30 * 1000;
export const BENEFICIARY_ALLOCATION_MS = 18 * 1000;
export const OPERATOR_ALLOCATION_MS = 12 * 1000;

export type AllocationRole = "user" | "beneficiary" | "operator";

function normalizedCycleTime(timestampMs: number): number {
  return ((timestampMs % ALLOCATION_CYCLE_MS) + ALLOCATION_CYCLE_MS) % ALLOCATION_CYCLE_MS;
}

export function getAllocationAt(
  timestampMs: number,
  hasBeneficiary: boolean
): AllocationRole {
  const t = normalizedCycleTime(timestampMs);
  if (t < USER_ALLOCATION_MS) return "user";
  if (hasBeneficiary && t < USER_ALLOCATION_MS + BENEFICIARY_ALLOCATION_MS) {
    return "beneficiary";
  }
  return "operator";
}

export function getAllocationCountdownMsAt(
  timestampMs: number,
  hasBeneficiary: boolean
): number {
  const t = normalizedCycleTime(timestampMs);
  if (t < USER_ALLOCATION_MS) return USER_ALLOCATION_MS - t;
  if (hasBeneficiary && t < USER_ALLOCATION_MS + BENEFICIARY_ALLOCATION_MS) {
    return USER_ALLOCATION_MS + BENEFICIARY_ALLOCATION_MS - t;
  }
  return ALLOCATION_CYCLE_MS - t;
}
