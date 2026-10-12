import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAlgorithmId, type AlgorithmId } from "./algorithms.js";

const REVISION = "minewhile-v1-yespower-params-1";
const DEFAULT_PATH = "/var/lib/minewhile/verified-algorithms.json";

type VerificationRecord = {
  id: AlgorithmId;
  revision: string;
  verifiedAt: number;
  acceptedShares: number;
};

function storePath(): string {
  return process.env.ALGORITHM_VERIFICATION_PATH || DEFAULT_PATH;
}

function readStore(): VerificationRecord[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is VerificationRecord =>
      x && typeof x === "object" && isAlgorithmId(String(x.id)) && x.revision === REVISION
    );
  } catch {
    return [];
  }
}

function writeStore(records: VerificationRecord[]) {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function isAlgorithmVerified(id: AlgorithmId): boolean {
  if (id === "yespower") return true;
  return readStore().some((x) => x.id === id && x.revision === REVISION);
}

export function listVerifiedAlgorithms(): AlgorithmId[] {
  const ids = new Set<AlgorithmId>(["yespower"]);
  for (const record of readStore()) ids.add(record.id);
  return [...ids];
}

export function markAlgorithmVerified(id: AlgorithmId): VerificationRecord {
  if (id === "yespower") {
    return { id, revision: REVISION, verifiedAt: Date.now(), acceptedShares: 1 };
  }
  const records = readStore();
  const existing = records.find((x) => x.id === id && x.revision === REVISION);
  if (existing) {
    existing.acceptedShares += 1;
    existing.verifiedAt = Date.now();
    writeStore(records);
    return existing;
  }
  const record: VerificationRecord = {
    id,
    revision: REVISION,
    verifiedAt: Date.now(),
    acceptedShares: 1
  };
  records.push(record);
  writeStore(records);
  return record;
}
