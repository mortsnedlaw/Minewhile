import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual
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
const DEFAULT_STORE_PATH = fileURLToPath(new URL("../data/beneficiaries.json", import.meta.url));

export type BeneficiaryRecord = {
  id: string;
  payoutCurrency: string;
  payoutAddress: string;
  managementSecretHash: string;
  createdAt: number;
  enabled: boolean;
  acceptedShares?: number;
  rejectedShares?: number;
  lastShareAt?: number | null;
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
  for (let i = 0; i < 8; i++) result += BENEFICIARY_ALPHABET[randomInt(BENEFICIARY_ALPHABET.length)];
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
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Beneficiary store must contain an array.");
  return parsed;
}

function writeStore(records: BeneficiaryRecord[]) {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function validatePayout(currencyRaw: string, addressRaw: string) {
  const currency = currencyRaw.trim().toUpperCase();
  const address = addressRaw.trim();
  if (!/^[A-Z0-9]{2,16}$/.test(currency)) throw new Error("Invalid payout currency.");
  if (!address || address.length > 128 || /[\x00-\x1F\x7F]/.test(address)) {
    throw new Error("Invalid payout address.");
  }
  return { currency, address };
}

function findAny(records: BeneficiaryRecord[], value: string): BeneficiaryRecord | null {
  const id = normalizeBeneficiaryId(value);
  if (!isValidBeneficiaryId(id)) return null;
  return records.find((record) => normalizeBeneficiaryId(record.id) === id) ?? null;
}

export function getBeneficiary(value: string): BeneficiaryRecord | null {
  const found = findAny(readStore(), value);
  return found?.enabled === true ? found : null;
}

export function createBeneficiary(payoutCurrency: string, payoutAddress: string): CreatedBeneficiary {
  const { currency, address } = validatePayout(payoutCurrency, payoutAddress);
  const records = readStore();
  let id = "";
  do id = generateBeneficiaryId();
  while (records.some((x) => x.id === id));

  const managementSecret = generateManagementSecret();
  const beneficiary: BeneficiaryRecord = {
    id,
    payoutCurrency: currency,
    payoutAddress: address,
    managementSecretHash: hashManagementSecret(managementSecret),
    createdAt: Date.now(),
    enabled: true,
    acceptedShares: 0,
    rejectedShares: 0,
    lastShareAt: null
  };
  records.push(beneficiary);
  writeStore(records);
  return { beneficiary, managementSecret };
}

export function verifyManagementSecret(value: string, secret: string): boolean {
  const record = findAny(readStore(), value);
  if (!record || !secret) return false;
  const expected = Buffer.from(record.managementSecretHash, "hex");
  const actual = Buffer.from(hashManagementSecret(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function getBeneficiaryForManagement(value: string, secret: string) {
  const records = readStore();
  const record = findAny(records, value);
  if (!record || !verifyManagementSecret(value, secret)) return null;
  return {
    id: record.id,
    payoutCurrency: record.payoutCurrency,
    payoutAddress: record.payoutAddress,
    createdAt: record.createdAt,
    enabled: record.enabled,
    acceptedShares: Number(record.acceptedShares ?? 0),
    rejectedShares: Number(record.rejectedShares ?? 0),
    lastShareAt: record.lastShareAt ?? null
  };
}

export function updateBeneficiary(
  value: string,
  secret: string,
  payoutCurrency: string,
  payoutAddress: string,
  enabled: boolean
) {
  const records = readStore();
  const record = findAny(records, value);
  if (!record || !verifyManagementSecret(value, secret)) throw new Error("Invalid management credentials.");
  const { currency, address } = validatePayout(payoutCurrency, payoutAddress);
  record.payoutCurrency = currency;
  record.payoutAddress = address;
  record.enabled = Boolean(enabled);
  writeStore(records);
  return getBeneficiaryForManagement(record.id, secret);
}

export function incrementBeneficiaryStats(value: string, accepted: boolean) {
  const records = readStore();
  const record = findAny(records, value);
  if (!record) return;
  if (accepted) record.acceptedShares = Number(record.acceptedShares ?? 0) + 1;
  else record.rejectedShares = Number(record.rejectedShares ?? 0) + 1;
  record.lastShareAt = Date.now();
  writeStore(records);
}
