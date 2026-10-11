import {
  createHash,
  randomBytes,
  randomInt
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BENEFICIARY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEFAULT_STORE_PATH = fileURLToPath(
  new URL("../data/beneficiaries.json", import.meta.url)
);

export type BeneficiaryRecord = {
  id: string;
  payoutCurrency: string;
  payoutAddress: string;
  managementSecretHash: string;
  createdAt: number;
  enabled: boolean;
};

export type CreatedBeneficiary = {
  beneficiary: BeneficiaryRecord;
  managementSecret: string;
};

function storePath(): string {
  return process.env.BENEFICIARY_STORE_PATH || DEFAULT_STORE_PATH;
}

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

function readStore(): BeneficiaryRecord[] {
  const path = storePath();

  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Beneficiary store must contain an array.");
  }

  return parsed;
}

function writeStore(records: BeneficiaryRecord[]) {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.${process.pid}.tmp`;

  writeFileSync(
    tmp,
    JSON.stringify(records, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 }
  );

  renameSync(tmp, path);
}

export function getBeneficiary(value: string): BeneficiaryRecord | null {
  const id = normalizeBeneficiaryId(value);

  if (!isValidBeneficiaryId(id)) return null;

  const found = readStore().find(
    (record) =>
      normalizeBeneficiaryId(record.id) === id &&
      record.enabled === true
  );

  return found ?? null;
}

export function createBeneficiary(
  payoutCurrency: string,
  payoutAddress: string
): CreatedBeneficiary {
  const currency = payoutCurrency.trim().toUpperCase();
  const address = payoutAddress.trim();

  if (!/^[A-Z0-9]{2,16}$/.test(currency)) {
    throw new Error("Invalid payout currency.");
  }

  if (
    !address ||
    address.length > 128 ||
    /[\x00-\x1F\x7F]/.test(address)
  ) {
    throw new Error("Invalid payout address.");
  }

  const records = readStore();

  let id = "";
  do {
    id = generateBeneficiaryId();
  } while (records.some((x) => x.id === id));

  const managementSecret = generateManagementSecret();

  const beneficiary: BeneficiaryRecord = {
    id,
    payoutCurrency: currency,
    payoutAddress: address,
    managementSecretHash: hashManagementSecret(managementSecret),
    createdAt: Date.now(),
    enabled: true
  };

  records.push(beneficiary);
  writeStore(records);

  return {
    beneficiary,
    managementSecret
  };
}
