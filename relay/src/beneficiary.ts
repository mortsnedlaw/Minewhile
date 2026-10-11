import {
  createHash,
  randomBytes,
  randomInt
} from "node:crypto";

const BENEFICIARY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type BeneficiaryRecord = {
  id: string;
  payoutCurrency: string;
  payoutAddress: string;
  managementSecretHash: string;
  createdAt: number;
  enabled: boolean;
};

export function normalizeBeneficiaryId(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

export function isValidBeneficiaryId(value: string): boolean {
  return /^[A-HJ-NP-Z2-9]{8}$/.test(normalizeBeneficiaryId(value));
}

export function generateBeneficiaryId(): string {
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += BENEFICIARY_ALPHABET[randomInt(BENEFICIARY_ALPHABET.length)];
  }
  return result;
}

export function generateManagementSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashManagementSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
